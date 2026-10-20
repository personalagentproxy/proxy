import {afterEach, beforeEach, describe, expect, mock, setSystemTime, test} from 'bun:test';
import {Ok} from 'ts-results-es';

const createAgentTask = mock();
const getAgentTask = mock();
const finishAgentTask = mock();
const listOpenAgentTasks = mock();

mock.module('@proxy/db/task', () => ({createAgentTask, getAgentTask, finishAgentTask, listOpenAgentTasks}));

const agent = {agentId: 'agent-1', orgId: 'org-1', providerId: 'claude', name: 'Claude', experiments: []};
const caller = {agent, via: 'mcp' as const};
const row = {id: 'task-1', agentId: 'agent-1', title: 'Triage inbox', goal: 'Archive the newsletters', via: 'mcp' as const, createdAt: new Date('2026-10-16T09:00:00Z'), finishedAt: null};
const finishedRow = {...row, finishedAt: new Date('2026-10-16T09:30:00Z')};

beforeEach(() => {
	mock.clearAllMocks();
	createAgentTask.mockResolvedValue(Ok(row));
	getAgentTask.mockResolvedValue(Ok(row));
	finishAgentTask.mockResolvedValue(Ok(finishedRow));
});

describe('startAgentTask', () => {
	test('starts a task for the agent with the title and goal, trimmed, answering with its id as task', async () => {
		const {startAgentTask} = await import('./tasks');
		const result = await startAgentTask(caller, {title: ' Triage inbox ', goal: 'Archive the newsletters\n'});

		expect(createAgentTask).toHaveBeenCalledWith({orgId: 'org-1', agentId: 'agent-1', title: 'Triage inbox', goal: 'Archive the newsletters', via: 'mcp'});
		expect(result.unwrap()).toEqual({task: 'task-1', title: 'Triage inbox', goal: 'Archive the newsletters', startedAt: '2026-10-16T09:00:00.000Z', finishedAt: null});
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
});

describe('listAgentOpenTasks', () => {
	test('answers the agent’s tasks under way, each with its id as task', async () => {
		listOpenAgentTasks.mockResolvedValue(Ok([row]));
		const {listAgentOpenTasks} = await import('./tasks');
		const result = await listAgentOpenTasks(agent);

		expect(listOpenAgentTasks).toHaveBeenCalledWith('org-1', 'agent-1');
		expect(result.unwrap()).toEqual({tasks: [{task: 'task-1', title: 'Triage inbox', goal: 'Archive the newsletters', startedAt: '2026-10-16T09:00:00.000Z', finishedAt: null}]});
	});
});

describe('finishAgentTask', () => {
	test('marks the agent’s task finished and answers with when', async () => {
		const {finishAgentTask: finish} = await import('./tasks');
		const result = await finish(caller, {task: 'task-1'});

		expect(finishAgentTask).toHaveBeenCalledWith('org-1', 'agent-1', 'task-1');
		expect(result.unwrap()).toMatchObject({task: 'task-1', finishedAt: '2026-10-16T09:30:00.000Z'});
	});

	test('a task the agent does not have is not found', async () => {
		finishAgentTask.mockResolvedValue(Ok(null));
		const {finishAgentTask: finish} = await import('./tasks');
		const result = await finish(caller, {task: 'task-9'});

		expect(result.unwrapErr()).toMatchObject({kind: 'not_found', resource: 'task', id: 'task-9'});
	});
});

describe('requireOpenTask', () => {
	// Three hours after the task started.
	beforeEach(() => setSystemTime(new Date('2026-10-16T12:00:00Z')));
	afterEach(() => setSystemTime());

	test('answers the agent’s task while it is under way', async () => {
		const {requireOpenTask} = await import('./tasks');
		const result = await requireOpenTask(agent, 'task-1');

		expect(getAgentTask).toHaveBeenCalledWith('org-1', 'agent-1', 'task-1');
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
	});

	test('a task never finished is abandoned a day after it started', async () => {
		const {requireOpenTask} = await import('./tasks');
		setSystemTime(new Date('2026-10-17T08:59:59Z'));
		const lastSecond = await requireOpenTask(agent, 'task-1');
		setSystemTime(new Date('2026-10-17T09:00:00Z'));
		const abandoned = await requireOpenTask(agent, 'task-1');

		expect(lastSecond.unwrap()).toBe(row);
		expect(abandoned.unwrapErr()).toEqual({
			kind: 'conflict',
			statusCode: 409,
			message: 'Task task-1 (Triage inbox) was started over a day ago and never finished, so it is taken as abandoned. Start a new task for what you are doing now, and give its id as task.',
		});
	});
});

describe('getAgentOpenTask', () => {
	beforeEach(() => setSystemTime(new Date('2026-10-16T12:00:00Z')));
	afterEach(() => setSystemTime());

	test('answers the task while it is under way, and refuses it as a call for it would be', async () => {
		const {getAgentOpenTask} = await import('./tasks');
		const open = await getAgentOpenTask(agent, 'task-1');
		getAgentTask.mockResolvedValue(Ok(finishedRow));
		const finished = await getAgentOpenTask(agent, 'task-1');

		expect(open.unwrap()).toEqual({task: 'task-1', title: 'Triage inbox', goal: 'Archive the newsletters', startedAt: '2026-10-16T09:00:00.000Z', finishedAt: null});
		expect(finished.unwrapErr()).toMatchObject({kind: 'conflict', statusCode: 409});
	});
});
