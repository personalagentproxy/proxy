import type {Response} from 'express';

import {CLI_STATUS, cliCallBodySchema, type CliCallFailure} from '@proxy/contracts/cli';

import {agentScriptHost} from '../script/agent-host';
import type {CliRequest} from '../server/middleware/require-cli';

/**
 * `POST /api/cli/call` (@proxy/contracts/cli): a `pap` function called by code in a sandbox,
 * answered as the `script` tool's are (script/agent-host.ts), through the same gate and into the
 * same log, as the token's agent for the token's task, coming in as `cli`. The token fixes the
 * task, so starting and finishing one is refused, and no Sandboxes connection is reached from
 * inside a sandbox. What went wrong with the call is 422, with the host's words for a model.
 */

function failed(res: Response, failure: CliCallFailure): void {
	res.status(CLI_STATUS.failed).json(failure);
}

export async function handleCliCallRoute(req: CliRequest, res: Response): Promise<void> {
	const parsed = cliCallBodySchema.safeParse(req.body);
	if (!parsed.success) {
		const issues = parsed.error.issues.map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`).join('; ');
		failed(res, {error: 'validation_error', message: `Takes {method, args}, method one of connections, tools, call and feedback: ${issues}`});
		return;
	}
	const {agent, taskId} = req.cli;
	const host = agentScriptHost(agent, {via: 'cli', task: taskId, taskTools: false, sandboxes: false});
	const answer = await host.answer(parsed.data.method, parsed.data.args);
	if (answer.isErr()) {
		failed(res, {error: answer.error.kind, message: answer.error.message});
		return;
	}
	// The host's answer is JSON already, so it goes into the body as it is.
	res.status(CLI_STATUS.ok).type('json').send(`{"result":${answer.value}}`);
}
