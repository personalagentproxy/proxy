import {Err} from 'ts-results-es';
import {z} from 'zod';

import {ApiErr, Do, parseSchema, requirePresent} from '@proxy/utils';
import {SANDBOX_EXEC_DEFAULT_SECONDS, SANDBOX_EXEC_MAX_SECONDS} from '@proxy/integrations';
import {getSandbox, touchSandbox} from '@proxy/db/sandbox';
import type {SandboxOutput} from '@proxy/backends/sandbox/backend';

import {papBundle} from '../../cli/bundle';
import {cliCommandEnv, requireCliTokenConfig} from '../../cli/command-env';
import type {NativeToolRunner} from '../tool';
import {holdForTask} from './lease';
import {requireBackend, wakeSandbox} from './machines';
import {ensurePap, withPapOnPath} from './pap';

/**
 * The console, `sandbox_exec`: a command run in a sandbox of the connection's for the caller's
 * task, which takes the sandbox (lease.ts) and wakes it where it was asleep. What the command
 * wrote and how it ended come back as text the model reads as it would a terminal. With `pap`,
 * the command is given `PAP_URL` and `PAP_TOKEN`, so code in the sandbox can call `/api/cli` as
 * the agent, for the task, while the sandbox is still the task's (cli/command-env.ts), and finds
 * the `pap` CLI on its PATH, installed first where it isn't this server's (pap.ts); without it, no
 * credential and nothing installed. The activity log has the command as the agent gave it. The
 * token is signed once the sandbox is woken and pap installed, so it lasts as long as the command
 * may.
 */

const paramsSchema = z.object({
	sandbox: z.string().min(1),
	command: z.string().min(1),
	stdin: z.string().optional(),
	cwd: z.string().optional(),
	timeout: z.number().positive().max(SANDBOX_EXEC_MAX_SECONDS).optional(),
	pap: z.boolean().optional(),
});

// How much of each stream the model is given; the gate cuts the whole answer further.
const MAX_STREAM_CHARS = 30_000;

function cut(text: string): string {
	if (text.length <= MAX_STREAM_CHARS) {
		return text;
	}
	return `${text.slice(0, MAX_STREAM_CHARS)}\n[Cut: ${text.length} characters in all.]`;
}

// The output as the model reads it: how the command ended, then what it wrote, each stream where it wrote anything.
export function describeOutput(output: SandboxOutput, timeoutSeconds: number): string {
	const ended = output.timedOut ? `Stopped after ${timeoutSeconds} seconds: the command did not finish in time.` : `Exit code: ${output.exitCode ?? 'none'}`;
	const parts = [ended];
	if (output.stdout !== '') {
		parts.push(`stdout:\n${cut(output.stdout)}`);
	}
	if (output.stderr !== '') {
		parts.push(`stderr:\n${cut(output.stderr)}`);
	}
	if (output.stdout === '' && output.stderr === '') {
		parts.push('(no output)');
	}
	return parts.join('\n\n');
}

/** Runs the command for the caller's task, in the sandbox named, woken where asleep. */
export const runSandboxCommand: NativeToolRunner = ({caller, connection, params}) =>
	Do(async ($): Promise<string> => {
		const parsed = parseSchema(paramsSchema, params);
		if (parsed.isErr()) {
			return $(Err(ApiErr.validationError(`sandbox_exec takes sandbox, command, and stdin, cwd, timeout and pap where wanted: ${parsed.error.kind === 'parse_error' ? parsed.error.message : ''}`)));
		}
		const {sandbox: sandboxId, command, stdin, cwd, timeout = SANDBOX_EXEC_DEFAULT_SECONDS, pap = false} = parsed.value;
		const config = pap ? $(requireCliTokenConfig()) : null;
		const bundle = pap ? $(await papBundle()) : null;
		const backend = $(await requireBackend());
		const found = $(requirePresent($(await getSandbox(connection.id, sandboxId)), ApiErr.notFound('sandbox', sandboxId, `No sandbox ${sandboxId}: give its id, not its name.`)));
		$(await holdForTask(found, caller.taskId));
		const running = $(await wakeSandbox(found));
		if (bundle !== null) {
			$(await ensurePap(backend, running, bundle));
		}
		const claims = {agentId: caller.agent.agentId, orgId: caller.agent.orgId, ownerUserId: caller.agent.ownerUserId, taskId: caller.taskId, sandboxId: running.id, connectionId: connection.id};
		const sent = config === null ? {command} : {command: withPapOnPath(command), env: cliCommandEnv(config, claims, timeout)};
		const output = $(await backend.exec(running.backendRef, {...sent, stdin, cwd, timeoutMs: Math.round(timeout * 1000)}));
		$(await touchSandbox(running.id));
		return describeOutput(output, timeout);
	});
