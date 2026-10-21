import {beforeEach, describe, expect, mock, test} from 'bun:test';
import {Ok} from 'ts-results-es';

const saveAgentFeedback = mock();

mock.module('@proxy/db/feedback', () => ({saveAgentFeedback}));

const agent = {agentId: 'agent-1', orgId: 'org-1', ownerUserId: 'user-1', providerId: 'claude', name: 'Claude', experiments: []};

beforeEach(() => {
	mock.clearAllMocks();
	saveAgentFeedback.mockResolvedValue(Ok(undefined));
});

describe('sendAgentFeedback', () => {
	test('keeps the message, trimmed, with the agent and what it is about', async () => {
		const {sendAgentFeedback} = await import('./feedback');
		const result = await sendAgentFeedback({agent, via: 'mcp'}, {message: '  emails_list ignored the folder \n', connection: 'mail-1', tool: 'emails_list'});

		expect(result.unwrap()).toEqual({sent: true});
		expect(saveAgentFeedback).toHaveBeenCalledWith({
			orgId: 'org-1',
			agentId: 'agent-1',
			providerId: 'claude',
			message: 'emails_list ignored the folder',
			connectionId: 'mail-1',
			tool: 'emails_list',
			via: 'mcp',
			taskId: null,
		});
	});

	test('without a connection or a tool, keeps none', async () => {
		const {sendAgentFeedback} = await import('./feedback');
		await sendAgentFeedback({agent, via: 'web'}, {message: 'The pages are slow', connection: ''});

		expect(saveAgentFeedback).toHaveBeenCalledWith(expect.objectContaining({connectionId: null, tool: null, via: 'web'}));
	});

	test('keeps the task it names as it was given, one that was never started too', async () => {
		const {sendAgentFeedback} = await import('./feedback');
		const result = await sendAgentFeedback({agent, via: 'mcp'}, {message: 'start_task answered an id read refuses', task: 'task-9'});

		expect(result.unwrap()).toEqual({sent: true});
		expect(saveAgentFeedback).toHaveBeenCalledWith(expect.objectContaining({taskId: 'task-9'}));
	});

	test('an empty or overlong message is refused in words the agent can act on', async () => {
		const {sendAgentFeedback} = await import('./feedback');
		const empty = await sendAgentFeedback({agent, via: 'mcp'}, {message: '   '});
		const long = await sendAgentFeedback({agent, via: 'mcp'}, {message: 'x'.repeat(5001)});
		const missing = await sendAgentFeedback({agent, via: 'mcp'}, {});

		expect(empty.unwrapErr()).toMatchObject({kind: 'validation_error', message: expect.stringContaining('empty')});
		expect(long.unwrapErr()).toMatchObject({kind: 'validation_error', message: expect.stringContaining('under 5000')});
		expect(missing.unwrapErr().kind).toBe('parse_error');
		expect(saveAgentFeedback).not.toHaveBeenCalled();
	});
});
