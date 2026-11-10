import {Err, type Result} from 'ts-results-es';

import {ApiErr, type ApiError, Do} from '@proxy/utils';
import type {SandboxBackend} from '@proxy/backends/sandbox/backend';
import type {PapBundle} from '@proxy/cli/build';
import {setSandboxPapVersion, type SandboxRow} from '@proxy/db/sandbox';

/**
 * The `pap` CLI in a sandbox, for commands run with `pap: true` (exec.ts): installed as
 * `$HOME/.local/bin/pap` where the sandbox's recorded version isn't this server's, by a command of
 * its own with the bundle as its stdin, so the sandbox downloads nothing. It writes a file beside
 * it and moves it into place, so a command running at the same time finds the old pap or the new,
 * never half of one. The install has its own timeout and no token, and leaves the agent's command
 * as it was. Without `pap: true`, nothing is installed.
 */

const INSTALL_TIMEOUT_MS = 20_000;

const INSTALL = `set -e
dir="$HOME/.local/bin"
mkdir -p "$dir"
tmp="$dir/.pap.$$"
trap 'rm -f "$tmp"' EXIT
cat > "$tmp"
chmod +x "$tmp"
mv -f "$tmp" "$dir/pap"`;

/** What goes before a `pap: true` command, so `pap` is found whatever the sandbox's PATH. */
export const PAP_PATH_LINE = 'export PATH="$HOME/.local/bin:$PATH"';

/** The command the backend is sent for a `pap: true` command: the agent's, with pap on its PATH. */
export function withPapOnPath(command: string): string {
	return `${PAP_PATH_LINE}\n${command}`;
}

/** Installs the bundle in the sandbox where its recorded version is another, and records it. */
export function ensurePap(backend: SandboxBackend, sandbox: SandboxRow, bundle: PapBundle): Promise<Result<void, ApiError>> {
	return Do(async ($) => {
		if (sandbox.papVersion === bundle.version) {
			return;
		}
		const output = $(await backend.exec(sandbox.backendRef, {command: INSTALL, stdin: bundle.code, timeoutMs: INSTALL_TIMEOUT_MS}));
		if (output.timedOut || output.exitCode !== 0) {
			const why = output.timedOut ? 'it took too long' : output.stderr.trim().split('\n').at(-1) || `exit code ${output.exitCode ?? 'none'}`;
			return $(Err(ApiErr.unavailable(`pap could not be installed in the sandbox (${why}), so the command was not run. Try again, or run it without pap.`)));
		}
		$(await setSandboxPapVersion(sandbox.id, bundle.version));
	});
}
