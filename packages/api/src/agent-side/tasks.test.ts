import {afterEach, beforeEach, describe, expect, mock, setSystemTime, test} from 'bun:test';
import {Ok} from 'ts-results-es';

const createAgentTask = mock();
const getAgentTask = mock();
const finishAgentTask = mock();
const listOpenAgentTasks = mock();
const touchAgentTask = mock();

mock.module('@proxy/db/task', () => ({createAgentTask, getAgentTask, finishAgentTask, listOpenAgentTasks, touchAgentTask}));

const agent = {agentId: 'agent-1', orgId: 'org-1', ownerUserId: 'user-1', providerId: 'claude', name: 'Claude', orgSlug: 'org-1', experiments: []};
const caller = {agent, via: 'mcp' as const};
const row = {
	id: 'task-1',
	agentId: 'agent-1',
	personaId: null,
	parentId: null,
	title: 'Triage inbox',
	goal: 'Archive the newsletters',
	via: 'mcp' as const,
	createdAt: new Date('2026-10-16T09:00:00Z'),
	finishedAt: null,
	outcome: null,
	lastActiveAt: new Date('2026-10-16T09:00:00Z'),
};
const finishedRow = {...row, finishedAt: new Date('2026-10-16T09:30:00Z'), outcome: 'Archived 12 newsletters'};
// The agent's task a sub-task is started for.
const parentRow = {...row, id: 'task-0', title: 'Plan the week', goal: 'List the week’s events and what to do first'};
const response = {task: 'task-1', parent: null, title: 'Triage inbox', goal: 'Archive the newsletters', startedAt: '2026-10-16T09:00:00.000Z', finishedAt: null, outcome: null};

beforeEach(() => {
	mock.clearAllMocks();
	createAgentTask.mockResolvedValue(Ok(row));
	getAgentTask.mockResolvedValue(Ok(row));
	finishAgentTask.mockResolvedValue(Ok(finishedRow));
	touchAgentTask.mockResolvedValue(Ok(true));
});

describe('startAgentTask', () => {
	test('starts a task for the agent with the title and goal, trimmed, answering with its id as task', async () => {
		const {startAgentTask} = await import('./tasks');
		const result = await startAgentTask(caller, {title: ' Triage inbox ', goal: 'Archive the newsletters\n'});

		expect(createAgentTask).toHaveBeenCalledWith({orgId: 'org-1', agentId: 'agent-1', ownerUserId: 'user-1', parentId: null, title: 'Triage inbox', goal: 'Archive the newsletters', via: 'mcp'});
		expect(getAgentTask).not.toHaveBeenCalled();
		expect(result.unwrap()).toEqual(response);
	});

	test('an empty, overlong or missing title or goal is refused in words the agent can act on', async () => {
		const {startAgentTask} = await import('./tasks');
		const noTitle = await startAgentTask(caller, {title: '  ', goal: 'Archive the newsletters'});
		const noGoal = await startAgentTask(caller, {title: 'Triage inbox', goal: ''});
		const longTitle = await startAgentTask(caller, {title: 'x'.repeat(121), goal: 'Archive the newsletters'});
		const longGoal = await startAgentTask(caller, {title: 'Triage inbox', goal: 'x'.repeat(2001)});
		const missing = await startAgentTask(caller, {title: 'Triage inbox'});

		expect(noTitle.unwrapErr()).toMatchObject({kind: 'validation_error', message: expect.stringContaining('needs a title')});
		expect(noGoal.unwrapErr()).toMatchObject({kind: 'validation_error', message: expect.stringContaining('needs a goal')});
		expect(longTitle.unwrapErr()).toMatchObject({kind: 'validation_error', message: expect.stringContaining('under 120')});
		expect(longGoal.unwrapErr()).toMatchObject({kind: 'validation_error', message: expect.stringContaining('under 2000')});
		expect(missing.unwrapErr().kind).toBe('parse_error');
		expect(createAgentTask).not.toHaveBeenCalled();
	});

	describe('with a parent', () => {
		// Ten minutes after the parent started.
		beforeEach(() => setSystemTime(new Date('2026-10-16T09:10:00Z')));
		afterEach(() => setSystemTime());

		test('starts a sub-task of one of the agent’s tasks under way, answering with the parent', async () => {
			getAgentTask.mockResolvedValue(Ok(parentRow));
			createAgentTask.mockResolvedValue(Ok({...row, parentId: 'task-0'}));
			const {startAgentTask} = await import('./tasks');
			const result = await startAgentTask(caller, {title: 'Triage inbox', goal: 'Archive the newsletters', parent: ' task-0 '});

			expect(getAgentTask).toHaveBeenCalledWith('org-1', 'agent-1', 'task-0');
			expect(createAgentTask).toHaveBeenCalledWith({orgId: 'org-1', agentId: 'agent-1', ownerUserId: 'user-1', parentId: 'task-0', title: 'Triage inbox', goal: 'Archive the newsletters', via: 'mcp'});
			expect(result.unwrap()).toEqual({...response, parent: 'task-0'});
		});

		test('an empty parent is none', async () => {
			const {startAgentTask} = await import('./tasks');
			const result = await startAgentTask(caller, {title: 'Triage inbox', goal: 'Archive the newsletters', parent: ''});

			expect(getAgentTask).not.toHaveBeenCalled();
			expect(createAgentTask).toHaveBeenCalledWith(expect.objectContaining({parentId: null}));
			expect(result.unwrap()).toEqual(response);
		});

		test('a parent the agent does not have, unknown or another agent’s, is not found', async () => {
			getAgentTask.mockResolvedValue(Ok(null));
			const {startAgentTask} = await import('./tasks');
			const result = await startAgentTask(caller, {title: 'Triage inbox', goal: 'Archive the newsletters', parent: 'task-9'});

			expect(result.unwrapErr()).toMatchObject({kind: 'not_found'});
			expect(createAgentTask).not.toHaveBeenCalled();
		});

		test('a parent finished is refused as a conflict, saying to start a new task', async () => {
			const {startAgentTask} = await import('./tasks');
			getAgentTask.mockResolvedValue(Ok({...parentRow, finishedAt: new Date('2026-10-16T10:00:00Z')}));
			const finished = await startAgentTask(caller, {title: 'Triage inbox', goal: 'Archive the newsletters', parent: 'task-0'});

			expect(finished.unwrapErr()).toEqual({
				kind: 'conflict',
				statusCode: 409,
				message: 'Task task-0 (Plan the week) is finished. Start a new task for what you are doing now, and give its id as task.',
			});
			expect(createAgentTask).not.toHaveBeenCalled();
		});

		test('a parent left open is taken up again, and the sub-task started under it', async () => {
			getAgentTask.mockResolvedValue(Ok({...parentRow, lastActiveAt: new Date('2026-10-16T08:30:00Z')}));
			createAgentTask.mockResolvedValue(Ok({...row, parentId: 'task-0'}));
			const {startAgentTask} = await import('./tasks');
			const result = await startAgentTask(caller, {title: 'Triage inbox', goal: 'Archive the newsletters', parent: 'task-0'});

			expect(touchAgentTask).toHaveBeenCalledWith('org-1', 'agent-1', 'task-0');
			expect(result.unwrap()).toEqual({...response, parent: 'task-0'});
		});

		test('a parent finished between the check and the start is refused as a conflict too', async () => {
			getAgentTask.mockResolvedValue(Ok(parentRow));
			createAgentTask.mockResolvedValue(Ok(null));
			const {startAgentTask} = await import('./tasks');
			const result = await startAgentTask(caller, {title: 'Triage inbox', goal: 'Archive the newsletters', parent: 'task-0'});

			expect(result.unwrapErr()).toMatchObject({kind: 'conflict', message: expect.stringContaining('Task task-0, or a task it is part of, is finished')});
		});
	});
});

describe('listAgentOpenTasks', () => {
	test('answers the agent’s tasks under way, each with its id as task', async () => {
		listOpenAgentTasks.mockResolvedValue(Ok([row]));
		const {listAgentOpenTasks} = await import('./tasks');
		const result = await listAgentOpenTasks(agent);

		expect(listOpenAgentTasks).toHaveBeenCalledWith('org-1', 'agent-1');
		expect(result.unwrap()).toEqual({tasks: [response]});
	});
});

describe('finishAgentTask', () => {
	test('marks the agent’s task finished, with the outcome trimmed, and answers with when and what was done', async () => {
		const {finishAgentTask: finish} = await import('./tasks');
		const result = await finish(caller, {task: 'task-1', outcome: ' Archived 12 newsletters\n'});

		expect(finishAgentTask).toHaveBeenCalledWith('org-1', 'agent-1', 'task-1', 'Archived 12 newsletters');
		expect(result.unwrap()).toMatchObject({task: 'task-1', finishedAt: '2026-10-16T09:30:00.000Z', outcome: 'Archived 12 newsletters'});
	});

	test('without an outcome, or with an empty one, none is kept; an overlong one is refused', async () => {
		const {finishAgentTask: finish} = await import('./tasks');
		await finish(caller, {task: 'task-1'});
		await finish(caller, {task: 'task-1', outcome: '  '});
		const long = await finish(caller, {task: 'task-1', outcome: 'x'.repeat(2001)});

		expect(finishAgentTask.mock.calls).toEqual([
			['org-1', 'agent-1', 'task-1', null],
			['org-1', 'agent-1', 'task-1', null],
		]);
		expect(long.unwrapErr()).toMatchObject({kind: 'validation_error', message: expect.stringContaining('under 2000')});
	});

	test('a task the agent does not have is not found', async () => {
		finishAgentTask.mockResolvedValue(Ok(null));
		const {finishAgentTask: finish} = await import('./tasks');
		const result = await finish(caller, {task: 'task-9'});

		expect(result.unwrapErr()).toMatchObject({kind: 'not_found', resource: 'task', id: 'task-9'});
	});

	test('a task left open under a task finished without it is refused as a conflict', async () => {
		finishAgentTask.mockResolvedValue(Ok(row));
		const {finishAgentTask: finish} = await import('./tasks');
		const result = await finish(caller, {task: 'task-1', outcome: 'Archived 12 newsletters'});

		expect(result.unwrapErr()).toEqual({
			kind: 'conflict',
			statusCode: 409,
			message: "Task task-1 (Triage inbox) was left open, and a task it is part of was finished without it, so it can't be finished any more.",
		});
	});
});

describe('requireOpenTask', () => {
	// Ten minutes after the task started.
	beforeEach(() => setSystemTime(new Date('2026-10-16T09:10:00Z')));
	afterEach(() => setSystemTime());

	test('answers the agent’s task while it is under way, the call counting as something done for it', async () => {
		const {requireOpenTask} = await import('./tasks');
		const result = await requireOpenTask(agent, 'task-1');

		expect(getAgentTask).toHaveBeenCalledWith('org-1', 'agent-1', 'task-1');
		expect(touchAgentTask).toHaveBeenCalledWith('org-1', 'agent-1', 'task-1');
		expect(result.unwrap()).toBe(row);
	});

	test('a call within a minute of the last thing done for the task is not written again', async () => {
		const {requireOpenTask} = await import('./tasks');
		setSystemTime(new Date('2026-10-16T09:00:59Z'));
		const result = await requireOpenTask(agent, 'task-1');

		expect(touchAgentTask).not.toHaveBeenCalled();
		expect(result.unwrap()).toBe(row);
	});

	test('a task the agent does not have is not found; one finished is refused as a conflict, saying to start a new one', async () => {
		const {requireOpenTask} = await import('./tasks');
		getAgentTask.mockResolvedValue(Ok(null));
		const unknown = await requireOpenTask(agent, 'task-9');
		getAgentTask.mockResolvedValue(Ok(finishedRow));
		const finished = await requireOpenTask(agent, 'task-1');

		expect(unknown.unwrapErr()).toMatchObject({kind: 'not_found', resource: 'task', id: 'task-9'});
		expect(finished.unwrapErr()).toEqual({
			kind: 'conflict',
			statusCode: 409,
			message: 'Task task-1 (Triage inbox) is finished. Start a new task for what you are doing now, and give its id as task.',
		});
		expect(touchAgentTask).not.toHaveBeenCalled();
	});

	test('a task left open, 20 minutes or more with nothing done for it, is taken up again by the call', async () => {
		const {requireOpenTask} = await import('./tasks');
		setSystemTime(new Date('2026-10-16T11:00:00Z'));
		const result = await requireOpenTask(agent, 'task-1');

		expect(touchAgentTask).toHaveBeenCalledWith('org-1', 'agent-1', 'task-1');
		expect(result.unwrap()).toBe(row);
	});

	test('a task finished since it was read, or left open under a task finished, is refused as a conflict', async () => {
		touchAgentTask.mockResolvedValue(Ok(false));
		const {requireOpenTask} = await import('./tasks');
		const result = await requireOpenTask(agent, 'task-1');

		expect(result.unwrapErr()).toEqual({
			kind: 'conflict',
			statusCode: 409,
			message: 'Task task-1 (Triage inbox), or a task it is part of, is finished. Start a new task for what you are doing now, and give its id as task.',
		});
	});
});

describe('getAgentOpenTask', () => {
	beforeEach(() => setSystemTime(new Date('2026-10-16T09:10:00Z')));
	afterEach(() => setSystemTime());

	test('answers the task while it is under way, and refuses it as a call for it would be', async () => {
		const {getAgentOpenTask} = await import('./tasks');
		const open = await getAgentOpenTask(agent, 'task-1');
		getAgentTask.mockResolvedValue(Ok(finishedRow));
		const finished = await getAgentOpenTask(agent, 'task-1');

		expect(open.unwrap()).toEqual(response);
		expect(finished.unwrapErr()).toMatchObject({kind: 'conflict', statusCode: 409});
	});
});
