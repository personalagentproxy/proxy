import type {Io} from './io';

/**
 * Finding a program pap runs, git or gh, as a shell would: the first of its name on the PATH that
 * can be run, but in the directories given to skip, as `pap gh` puts its git shim first on gh's
 * PATH and `pap git` must find the real git behind it.
 */

/** Where `pap gh` put the git shim it runs gh with, for `pap git` to look past. */
export const SHIM_DIR_ENV = 'PAP_GIT_SHIM';

/** The GitHub connection `pap git` and `pap gh` are for, as `pap --connection <id>` sets it. */
export const CONNECTION_ENV = 'PAP_GITHUB_CONNECTION';

export function findProgram(
	name: string,
	io: Io,
	skip: Array<string | undefined> = [],
): string | null {
	const skipped = new Set(skip.flatMap((dir) => (dir ? [trimSlash(dir)] : [])));
	for (const dir of (io.env.PATH ?? '').split(':')) {
		if (dir === '' || skipped.has(trimSlash(dir))) {
			continue;
		}
		const path = `${trimSlash(dir)}/${name}`;
		if (io.isExecutable(path)) {
			return path;
		}
	}
	return null;
}

function trimSlash(dir: string): string {
	return dir.length > 1 ? dir.replace(/\/+$/, '') : dir;
}

/** The GitHub connection named, if any. */
export function namedConnection(io: Io): string | undefined {
	return io.env[CONNECTION_ENV]?.trim() || undefined;
}
