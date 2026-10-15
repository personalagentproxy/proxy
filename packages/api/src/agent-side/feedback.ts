import {Err, type Result} from 'ts-results-es';
import {z} from 'zod';

import {ApiErr, type ApiError, Do, parseSchema} from '@proxy/utils';
import {saveAgentFeedback} from '@proxy/db/feedback';

import type {AgentCaller} from './tools';

// Feedback an agent sends the makers of Personal Agent Proxy, such as a tool that didn't work as it
// expected, over MCP or from the agent pages. It is kept for us to read; nothing in the app shows it.

const MAX_MESSAGE = 5000;

const feedbackSchema = z.object({
	message: z.string(),
	connection: z.string().max(200).optional(),
	tool: z.string().max(200).optional(),
});

/** Keeps the agent's feedback: `{message}`, and the connection and tool it is about where it names them. */
export function sendAgentFeedback(caller: AgentCaller, args: unknown): Promise<Result<{sent: true}, ApiError>> {
	return Do(async ($) => {
		const {message, connection, tool} = $(parseSchema(feedbackSchema, args));
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
			}),
		);
		return {sent: true};
	});
}
