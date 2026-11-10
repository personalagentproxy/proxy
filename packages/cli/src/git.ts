import type {Result} from 'ts-results-es';

import {
	CLI_GITHUB_GIT_PATH,
	CLI_GITHUB_IDENTITY_PATH,
	type GitHubIdentity,
	PAP_CONNECTION_HEADER,
} from '@proxy/contracts/cli-github';
import {Do} from '@proxy/utils/do';

import {clientFrom, papServer, type PapServer} from './client';
import {type Env, EXIT, type Failure, type Io, isObject, type Json} from './io';
import {findProgram, namedConnection, SHIM_DIR_ENV} from './programs';

/**
 * `pap git`: the real git, run with its arguments, stdio and exit code as they are, signed in to
 * GitHub as the connection's account for this one run. Nothing is written to any git config: git
 * is given, through `GIT_CONFIG_COUNT` and its keys, GitHub's URLs (https and both SSH forms)
 * rewritten to PAP's git relay and the command's token as a header sent to the relay alone
 * (@proxy/contracts/cli-github), so whatever reaches GitHub goes through PAP, a partial clone's
 * objects fetched later among it; and the identity route's author and committer, unless the
 * environment sets them, or with none where PAP won't say. Only `git remote`, `-v` and `get-url`
 * are left their URLs, so they still show github.com, which gh reads to know the repository.
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

// Whether git only shows the remotes' URLs: `git remote`, `-v` and `get-url`.
function showsRemotes(args: string[]): boolean {
	const command = gitSubcommand(args);
	if (command?.name !== 'remote') {
		return false;
	}
	const sub = command.rest.find((arg) => !arg.startsWith('-'));
	return sub === undefined || sub === 'get-url';
}

export type GitSetup = {
	/** The server, and the connection named; none where git only shows the remotes' URLs. */
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

// Who commits are made as, from the identity route, for the connection named; none where PAP
// won't say, as where the agent can't read the connection.
async function fetchIdentity(io: Io): Promise<Identity> {
	const client = clientFrom(io);
	if (client.isErr()) {
		return null;
	}
	const connection = namedConnection(io);
	const headers: Record<string, string> = connection ? {[PAP_CONNECTION_HEADER]: connection} : {};
	const answer = await client.value.get(CLI_GITHUB_IDENTITY_PATH, headers);
	return answer.isOk() && answer.value.status === 200 ? identityOf(answer.value.body) : null;
}

/** Who commits are made as, unless the environment says in full. */
export function commitIdentity(io: Io): Promise<Identity> {
	if (IDENTITY_KEYS.every((key) => io.env[key])) {
		return Promise.resolve(null);
	}
	return fetchIdentity(io);
}

/** What git is to be run with for `args`. */
export function gitSetup(args: string[], io: Io): Promise<Result<GitSetup, Failure>> {
	return Do(async ($) => {
		const server = $(papServer(io));
		const relay = showsRemotes(args) ? null : {...server, connection: namedConnection(io)};
		const identity = gitSubcommand(args) === null ? null : await commitIdentity(io);
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
