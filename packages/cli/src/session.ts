import {chmod, mkdir, readFile, rename, rm, writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {Err, Ok, Result} from 'ts-results-es';
import {z} from 'zod';

import {Do} from '@proxy/utils';

import {CliErr, type CliError} from './cli-error';

/**
 * The agent's session, kept between commands: the server it signed in to, the cookie the server
 * set, and when that ends. The cookie signs the agent in, so the file is readable by its owner
 * alone, in a folder only they can open. Nothing else is kept: no password, no username.
 */

const sessionSchema = z.object({
	// The origin signed in to, `https://proxy.example.com`: every request goes there and nowhere else.
	origin: z.string(),
	cookie: z.object({name: z.string(), value: z.string()}),
	// When the server ends the session, as an ISO time.
	expires: z.string(),
});

export type Session = z.infer<typeof sessionSchema>;

const FILE = 'session.json';

/** `$XDG_CONFIG_HOME/proxy`, or `~/.config/proxy`. */
export function configDir(env: Record<string, string | undefined> = process.env): string {
	return join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'proxy');
}

function failed(what: string) {
	return (cause: unknown): CliError =>
		CliErr.failed(`${what}: ${cause instanceof Error ? cause.message : String(cause)}`);
}

function isMissing(error: unknown): boolean {
	return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

/** The session kept in `dir`, or null when there is none. */
export async function readSession(dir: string): Promise<Result<Session | null, CliError>> {
	const text = await Result.wrapAsync(() => readFile(join(dir, FILE), 'utf8'));
	if (text.isErr() && isMissing(text.error)) {
		return Ok(null);
	}
	return Do(async ($) => {
		const raw = $(text.mapErr(failed('The session could not be read')));
		const json = $(
			Result.wrap((): unknown => JSON.parse(raw)).mapErr(() =>
				CliErr.failed(`${join(dir, FILE)} is not a session: run proxy login again`),
			),
		);
		const session = sessionSchema.safeParse(json);
		if (!session.success) {
			return $(Err(CliErr.failed(`${join(dir, FILE)} is not a session: run proxy login again`)));
		}
		return session.data;
	});
}

/**
 * Keeps the session in `dir`, made or narrowed to 0700, in a file of 0600. It is written beside
 * the old one and moved over it, so a session is never half written.
 */
export async function writeSession(dir: string, session: Session): Promise<Result<void, CliError>> {
	const path = join(dir, FILE);
	const temporary = `${path}.${process.pid}.tmp`;
	return (
		await Result.wrapAsync(async () => {
			await mkdir(dir, {recursive: true, mode: 0o700});
			await chmod(dir, 0o700);
			await writeFile(temporary, `${JSON.stringify(session, null, 2)}\n`, {mode: 0o600});
			await chmod(temporary, 0o600);
			await rename(temporary, path);
		})
	).mapErr(failed('The session could not be saved'));
}

export async function removeSession(dir: string): Promise<Result<void, CliError>> {
	return (await Result.wrapAsync(() => rm(join(dir, FILE), {force: true}))).mapErr(
		failed('The session could not be removed'),
	);
}

/** The session, unless there is none or it has ended. */
export function requireLive(session: Session | null, now: Date): Result<Session, CliError> {
	if (!session) {
		return Err(CliErr.failed('Not signed in: run proxy login first'));
	}
	if (new Date(session.expires).getTime() <= now.getTime()) {
		return Err(CliErr.failed(`The session ended at ${session.expires}: run proxy login again`));
	}
	return Ok(session);
}
