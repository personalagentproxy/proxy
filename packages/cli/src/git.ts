import {Err, type Result} from 'ts-results-es';

import {
	CLI_GITHUB_GIT_PATH,
	CLI_GITHUB_IDENTITY_PATH,
	type GitHubIdentity,
	PAP_CONNECTION_HEADER,
} from '@proxy/contracts/cli-github';
import {Do} from '@proxy/utils/do';

import {clientFrom, messageOf, papServer, type PapServer} from './client';
import {type Env, EXIT, type Failure, failed, type Io, isObject, type Json, refused} from './io';
import {findProgram, namedConnection, SHIM_DIR_ENV} from './programs';

/**
 * `pap git`: the real git, run with its arguments, stdio and exit code as they are, signed in to
 * GitHub as the connection's account for this one run. Nothing is written to any git config: for a
 * subcommand that reaches a remote, git is given, through `GIT_CONFIG_COUNT` and its keys, GitHub's
 * URLs (https and both SSH forms) rewritten to PAP's git relay and the command's token as a header
 * sent to the relay alone (@proxy/contracts/cli-github); for one that makes commits, the identity
 * route's author and committer, unless the environment sets them. Other subcommands get neither, so
 * `git remote -v` still shows github.com, which gh reads to know the repository, and git works
 * without PAP where it needs no remote; the identity is asked for only where it is used, so `git
 * status` costs no request and needs no Read.
 */

// git's options before the subcommand that take the next argument as their value.
const VALUED = new Set([
	'-C',
	'-c',
	'--git-dir',
	'--work-tree',
	'--namespace',
	'--super-prefix',
	'--config-env',
	'--attr-source',
]);

// git's options after which it runs no subcommand of the arguments: it prints and exits, or hands
// the rest to help.
const ENDING = new Set([
	'-v',
	'--version',
	'-h',
	'--help',
	'--exec-path',
	'--html-path',
	'--man-path',
	'--info-path',
]);

const REACHES_REMOTE = new Set(['clone', 'fetch', 'pull', 'push', 'ls-remote', 'submodule']);

// `git remote`'s subcommands that contact the remote; `add` does with `-f`.
const REMOTE_CONTACTS = new Set(['update', 'show', 'prune', 'set-head']);

const MAKES_COMMITS = new Set([
	'commit',
	'merge',
	'pull',
	'rebase',
	'cherry-pick',
	'revert',
	'am',
	'tag',
	'stash',
	'notes',
	'commit-tree',
	'replace',
	'filter-branch',
	'fast-import',
	'subtree',
]);

const IDENTITY_KEYS = [
	'GIT_AUTHOR_NAME',
	'GIT_AUTHOR_EMAIL',
	'GIT_COMMITTER_NAME',
	'GIT_COMMITTER_EMAIL',
] as const;

/** The subcommand git runs and the arguments after it, or null where it runs none. */
export function gitSubcommand(args: string[]): {name: string; rest: string[]} | null {
	for (let at = 0; at < args.length; at++) {
		const arg = args[at] ?? '';
		if (!arg.startsWith('-')) {
			return {name: arg, rest: args.slice(at + 1)};
		}
		if (ENDING.has(arg) || arg.startsWith('--list-cmds=')) {
			return null;
		}
		if (VALUED.has(arg)) {
			at++;
		}
	}
	return null;
}

export type GitNeeds = {remote: boolean; identity: boolean};

/** What a git command needs of PAP: GitHub reached through the relay, and who commits are made as. */
export function gitNeeds(args: string[]): GitNeeds {
	const command = gitSubcommand(args);
	if (command === null) {
		return {remote: false, identity: false};
	}
	const {name, rest} = command;
	return {
		remote: REACHES_REMOTE.has(name) || (name === 'remote' && remoteContacts(rest)),
		identity: MAKES_COMMITS.has(name),
	};
}

function remoteContacts(rest: string[]): boolean {
	const sub = rest.find((arg) => !arg.startsWith('-'));
	if (sub === undefined) {
		return false;
	}
	if (sub === 'add') {
		return rest.includes('-f') || rest.includes('--fetch');
	}
	return REMOTE_CONTACTS.has(sub);
}

export type GitSetup = {
	/** For a subcommand that reaches a remote: the server, and the connection named. */
	relay: (PapServer & {connection: string | undefined}) | null;
	identity: Pick<GitHubIdentity, 'name' | 'email'> | null;
};

/**
 * The environment git is run with: `env` and, for this run alone, GitHub's URLs rewritten to the
 * relay with the token sent to it, its config entries after any the environment has; the identity
 * where the environment has none of its own.
 */
export function gitEnv(env: Env, {relay, identity}: GitSetup): Env {
	const result: Env = {...env};
	if (relay !== null) {
		const url = `${relay.base}${CLI_GITHUB_GIT_PATH}/`;
		const entries: Array<[string, string]> = [
			[`url.${url}.insteadOf`, 'https://github.com/'],
			[`url.${url}.insteadOf`, 'git@github.com:'],
			[`url.${url}.insteadOf`, 'ssh://git@github.com/'],
			[`http.${url}.extraHeader`, `Authorization: Bearer ${relay.token}`],
			...(relay.connection
				? [
						[`http.${url}.extraHeader`, `${PAP_CONNECTION_HEADER}: ${relay.connection}`] as [
							string,
							string,
						],
					]
				: []),
		];
		const given = env.GIT_CONFIG_COUNT?.trim() ?? '';
		const start = /^\d+$/.test(given) ? Number(given) : 0;
		entries.forEach(([key, value], index) => {
			result[`GIT_CONFIG_KEY_${start + index}`] = key;
			result[`GIT_CONFIG_VALUE_${start + index}`] = value;
		});
		result.GIT_CONFIG_COUNT = String(start + entries.length);
		result.GIT_TERMINAL_PROMPT = '0';
	}
	if (identity !== null) {
		const values = [identity.name, identity.email, identity.name, identity.email];
		IDENTITY_KEYS.forEach((key, index) => {
			result[key] = env[key] || values[index];
		});
	}
	return result;
}

type Identity = GitSetup['identity'];

function identityOf(body: Json | undefined): Identity {
	if (!isObject(body) || typeof body.name !== 'string' || typeof body.email !== 'string') {
		return null;
	}
	return {name: body.name, email: body.email};
}

// Who commits are made as, from the identity route, for the connection named.
function fetchIdentity(io: Io, connection: string | undefined): Promise<Result<Identity, Failure>> {
	return Do(async ($) => {
		const client = $(clientFrom(io));
		const headers: Record<string, string> = connection ? {[PAP_CONNECTION_HEADER]: connection} : {};
		const {status, body} = $(await client.get(CLI_GITHUB_IDENTITY_PATH, headers));
		const identity = status === 200 ? identityOf(body) : null;
		if (identity !== null) {
			return identity;
		}
		const why = `Could not get who to commit as: ${messageOf(body) ?? `PAP answered ${status}.`}`;
		return $(Err(status === 401 ? refused(why) : failed(why)));
	});
}

/** What git is to be run with for `args`, asking PAP only for what it needs. */
export function gitSetup(args: string[], io: Io): Promise<Result<GitSetup, Failure>> {
	return Do(async ($) => {
		const needs = gitNeeds(args);
		const connection = namedConnection(io);
		const relay = needs.remote ? {...$(papServer(io)), connection} : null;
		const ownIdentity = IDENTITY_KEYS.every((key) => io.env[key]);
		const identity = needs.identity && !ownIdentity ? $(await fetchIdentity(io, connection)) : null;
		return {relay, identity};
	});
}

/** The real git, skipping the shim `pap gh` puts in front of it. */
export function realGit(io: Io): string | null {
	return findProgram('git', io, [io.env[SHIM_DIR_ENV]]);
}

export const GIT_NOTE = `pap git <args>: git, signed in to GitHub as your GitHub connection's account; plain git is signed out.
Clone https://github.com/<owner>/<repo>; commits are made as that account.
With several GitHub connections: pap --connection <id> git <args>
`;

/** `pap git <args>`: git run as above, its exit code pap's. */
export async function gitMain(args: string[], io: Io): Promise<number> {
	if (args.length === 0) {
		io.out(GIT_NOTE);
		return EXIT.ok;
	}
	const git = realGit(io);
	if (git === null) {
		io.err('pap: git is not installed here.\n');
		return EXIT.failed;
	}
	const setup = await gitSetup(args, io);
	if (setup.isErr()) {
		io.err(`pap: ${setup.error.message}\n`);
		return setup.error.exit;
	}
	const ran = await io.spawn(git, args, gitEnv(io.env, setup.value));
	if (ran.isErr()) {
		io.err(`pap: could not run ${git}: ${ran.error.message}\n`);
		return EXIT.failed;
	}
	return ran.value;
}
