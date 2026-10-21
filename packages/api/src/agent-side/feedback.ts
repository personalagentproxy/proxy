import {Err, type Result} from 'ts-results-es';
import {z} from 'zod';

import {ApiErr, type ApiError, Do, parseSchema} from '@proxy/utils';
import {saveAgentFeedback} from '@proxy/db/feedback';

import type {AgentCaller} from './tools';

// Feedback an agent sends the makers of Personal Agent Proxy, such as a tool that didn't work as it
// expected, over MCP or from the agent pages, with the task it was on where it names one. It is
// kept for us to read; nothing in the app shows it. The connection, the tool and the task are kept
// as the agent gave them, unchecked: feedback is how an agent says something went wrong, such as a
// task id that wasn't taken, so it is never refused for what it is about.

const MAX_MESSAGE = 5000;

const feedbackSchema = z.object({
	message: z.string(),
	connection: z.string().max(200).optional(),
	tool: z.string().max(200).optional(),
	task: z.string().max(200).optional(),
});

/** Keeps the agent's feedback: `{message}`, and the connection, the tool and the task it is about where it names them. */
export function sendAgentFeedback(caller: AgentCaller, args: unknown): Promise<Result<{sent: true}, ApiError>> {
	return Do(async ($) => {
		const {message, connection, tool, task} = $(parseSchema(feedbackSchema, args));
		const text = message.trim();
		if (text === '') {
			return $(Err(ApiErr.validationError('The feedback is empty: say what happened and what you expected.')));
		}
		if (text.length > MAX_MESSAGE) {
			return $(Err(ApiErr.validationError(`The feedback is ${text.length} characters long; keep it under ${MAX_MESSAGE}.`)));
		}
		$(
			await saveAgentFeedback({
				orgId: caller.agent.orgId,
				agentId: caller.agent.agentId,
				providerId: caller.agent.providerId,
				message: text,
				connectionId: connection || null,
				tool: tool || null,
				via: caller.via,
				taskId: task || null,
			}),
		);
		return {sent: true};
	});
}
