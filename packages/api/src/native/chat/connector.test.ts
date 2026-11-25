import {beforeEach, describe, expect, mock, test} from 'bun:test';
import {Err, Ok} from 'ts-results-es';

import {ApiErr} from '@proxy/utils';
import {findCollection, findIntegration, type Collection} from '@proxy/integrations';
import type {MemberAlertRow} from '@proxy/db/alerts';
import type {MemberThreadRow} from '@proxy/db/chat';
import type {ChatThreadRow, ShownEntryRow} from '@proxy/db/harness';

mock.module('../../utils/env', () => ({env: {APP_URL: 'https://app.example.test'}}));

const listMemberThreads = mock();
const getThreadAddress = mock();
const getOrgSlug = mock();
mock.module('@proxy/db/chat', () => ({listMemberThreads, getThreadAddress, getOrgSlug}));

const getMemberThread = mock();
const changeMemberThreadStanding = mock();
const passOnToThread = mock();
const getPassingThread = mock();
const getPersona = mock();
const findMemberPersonas = mock();
const getMemberChat = mock();
const ensureMemberChat = mock();
const openPassedOnThread = mock();
mock.module('@proxy/db/harness', () => ({
	getMemberThread,
	changeMemberThreadStanding,
	passOnToThread,
	getPassingThread,
	getPersona,
	findMemberPersonas,
	getMemberChat,
	ensureMemberChat,
	openPassedOnThread,
}));

// The chat a new thread is opened in is the member's, begun where they have none (harness/member-chat.ts).
const ensureChat = mock();
mock.module('../../harness/member-chat', () => ({ensureChat}));

// Where in Slack one is opened (slack/openings.ts), and its root message posted at once (slack/delivery.ts).
const slackOpening = mock();
mock.module('../../slack/openings', () => ({slackOpening}));
const deliverNow = mock(async () => {});
mock.module('../../slack/delivery', () => ({deliverNow}));

const listMemberAlerts = mock();
const deleteAlert = mock();
mock.module('@proxy/db/alerts', () => ({listMemberAlerts, deleteAlert}));

function collection(id: string): Collection {
	const integration = findIntegration('chat');
	const found = integration && findCollection(integration, id);
	if (!found) {
		throw new Error(`No ${id} collection`);
	}
	return found;
}

const connection = {
	id: 'chat-1',
	integrationId: 'chat',
	orgId: 'org-1',
	ownerUserId: 'user-1',
	sharedWithEveryone: false,
	shares: [],
	account: 'Acme',
	createdAt: new Date(),
	tools: null,
	name: null,
	defaults: [],
	credentialRejectedAt: null,
	credential: null,
};
const threads = {connection, collection: collection('threads')};
const alerts = {connection, collection: collection('alerts')};
const all = {search: null, page: null, filter: null, parent: null};

const at = (minute: number) => new Date(Date.UTC(2026, 9, 21, 10, minute));

// Where a thread that lives in Slack is there, and its link: the thread under its root message in the DM.
const SLACK = {teamId: 'T0001', channel: 'D0001', rootTs: '1761040800.000100'};
const SLACK_URL = 'https://app.slack.com/client/T0001/D0001/thread/D0001-1761040800.000100';

// A thread as a list of the member's has it: stopped, waiting for them, its summary current.
function listed(over: Partial<MemberThreadRow> = {}): MemberThreadRow {
	return {
		id: 'thread-1',
		personaId: 'persona-1',
		personaName: 'Finance',
		title: 'Pricing review with Dana',
		slack: null,
		createdAt: at(0),
		state: {kind: 'stopped'},
		standing: {waitingForMember: true, summary: 'Asks which day suits Dana.', summarySeq: 2, archived: false},
		alerts: 0,
		last: {seq: 2, pending: false, createdAt: at(2)},
		...over,
	};
}

beforeEach(() => {
	mock.clearAllMocks();
	listMemberThreads.mockResolvedValue(Ok({orgSlug: 'acme', threads: [listed()]}));
	getThreadAddress.mockResolvedValue(Ok({orgSlug: 'acme', personaName: 'Finance', slack: null}));
	getOrgSlug.mockResolvedValue(Ok('acme'));
});

describe('the Chat connection’s threads', () => {
	test('are the member’s, whoever reads them through the connection, each with whom it is with, where it lives, where it stands, its summary and its page in Chat', async () => {
		const {threadsConnector} = await import('./connector');

		const page = (await threadsConnector.list(threads, all)).unwrap();

		expect(listMemberThreads).toHaveBeenCalledWith('org-1', 'user-1', {search: null, standing: null, skip: 0, take: 51});
		expect(page).toEqual({
			records: [
				{
					id: 'thread-1',
					values: {
						title: 'Pricing review with Dana',
						agent: 'Finance',
						place: 'Chat',
						standing: 'Waiting for you',
						summary: 'Asks which day suits Dana.',
						lastMessageAt: at(2).toISOString(),
						messages: '',
					},
					updatedAt: at(2).toISOString(),
					url: 'https://app.example.test/acme/chat/persona-1/threads/thread-1',
				},
			],
			nextPage: null,
		});
	});

	test('say a thread at work or asleep is in progress, one that stopped archived where the person archived it, else waiting where it waits, watching where alerts come to it, and done otherwise, and give a summary only while nothing was said past it', async () => {
		const {threadsConnector} = await import('./connector');
		listMemberThreads.mockResolvedValue(
			Ok({
				orgSlug: 'acme',
				threads: [
					listed({id: 'working', state: {kind: 'working'}, last: {seq: 3, pending: false, createdAt: at(3)}}),
					listed({id: 'asleep', state: {kind: 'asleep', until: at(30)}}),
					listed({id: 'done', standing: {waitingForMember: false, summary: 'Moved it to Friday.', summarySeq: 2, archived: false}}),
					listed({id: 'watching', alerts: 2, standing: {waitingForMember: false, summary: 'Watches for the contract.', summarySeq: 2, archived: false}}),
					listed({id: 'waiting-with-alerts', alerts: 1}),
					listed({id: 'pending', last: {seq: 2, pending: true, createdAt: at(4)}}),
					listed({id: 'unread', standing: {waitingForMember: false, summary: null, summarySeq: null, archived: false}}),
					listed({id: 'empty', title: null, standing: {waitingForMember: false, summary: null, summarySeq: null, archived: false}, last: null}),
					listed({id: 'archived', standing: {waitingForMember: true, summary: 'Asks which day suits Dana.', summarySeq: 2, archived: true}}),
					listed({id: 'archived-working', state: {kind: 'working'}, standing: {waitingForMember: false, summary: null, summarySeq: null, archived: true}}),
				],
			}),
		);

		const {records} = (await threadsConnector.list(threads, all)).unwrap();

		expect(records.map(({id, values}) => [id, values.standing, values.summary])).toEqual([
			['working', 'In progress', ''],
			['asleep', 'In progress', 'Asks which day suits Dana.'],
			['done', 'Done', 'Moved it to Friday.'],
			['watching', 'Watching', 'Watches for the contract.'],
			['waiting-with-alerts', 'Waiting for you', 'Asks which day suits Dana.'],
			['pending', 'Waiting for you', ''],
			['unread', 'Done', ''],
			['empty', 'Done', ''],
			['archived', 'Archived', 'Asks which day suits Dana.'],
			['archived-working', 'In progress', ''],
		]);
		// One nothing was said in is dated by when it was opened, and has no title.
		expect(records.find((record) => record.id === 'empty')?.values).toMatchObject({title: '', lastMessageAt: at(0).toISOString()});
	});

	test('are searched and narrowed to a standing by its word, a page at a time', async () => {
		const {threadsConnector} = await import('./connector');
		listMemberThreads.mockResolvedValue(Ok({orgSlug: 'acme', threads: Array.from({length: 51}, (_, index) => listed({id: `thread-${index}`}))}));

		const first = (await threadsConnector.list(threads, {...all, search: 'pricing', filter: 'Waiting for you'})).unwrap();

		expect(listMemberThreads).toHaveBeenCalledWith('org-1', 'user-1', {search: 'pricing', standing: 'waiting', skip: 0, take: 51});
		expect(first.records).toHaveLength(50);
		expect(first.nextPage).toBe('50');

		listMemberThreads.mockResolvedValue(Ok({orgSlug: 'acme', threads: [listed()]}));
		const second = (await threadsConnector.list(threads, {...all, page: '50', filter: 'In progress'})).unwrap();
		expect(listMemberThreads).toHaveBeenLastCalledWith('org-1', 'user-1', {search: null, standing: 'in_progress', skip: 50, take: 51});
		expect(second.nextPage).toBeNull();

		(await threadsConnector.list(threads, {...all, filter: 'Archived'})).unwrap();
		expect(listMemberThreads).toHaveBeenLastCalledWith('org-1', 'user-1', {search: null, standing: 'archived', skip: 0, take: 51});

		expect((await threadsConnector.list(threads, {...all, filter: 'Stuck'})).unwrapErr().kind).toBe('validation_error');
		expect((await threadsConnector.list(threads, {...all, page: 'next'})).unwrapErr().kind).toBe('validation_error');
		// An organization that is gone has none.
		listMemberThreads.mockResolvedValue(Ok(null));
		expect((await threadsConnector.list(threads, all)).unwrap()).toEqual({records: [], nextPage: null});
	});

	test('open with what was said in one, as the member sees it, and say where there is none such of theirs', async () => {
		const {threadsConnector} = await import('./connector');
		const entry = (id: string, seq: number, kind: 'person' | 'assistant', text: string) => ({
			id,
			seq,
			kind,
			text,
			pending: false,
			toolCalls: null,
			callId: null,
			isError: false,
			passedOn: null,
			createdAt: at(seq),
		});
		const thread: ChatThreadRow = {
			id: 'thread-1',
			orgId: 'org-1',
			agentId: 'login-1',
			personaId: 'persona-1',
			userId: 'user-1',
			parentThreadId: 'chat-1',
			subAgentOfId: null,
			parentCallId: null,
			title: 'Pricing review with Dana',
			taskId: 'task-1',
			harness: null,
			harnessSession: null,
			openedByAlert: false,
			createdAt: at(0),
			state: {kind: 'stopped'},
			standing: {waitingForMember: true, summary: 'Asks which day suits Dana.', summarySeq: 2, archived: false},
			alerts: 0,
			entries: [entry('e1', 1, 'person', 'Move the pricing review'), entry('e2', 2, 'assistant', 'Which day suits Dana?')],
			attachments: [],
			subAgents: [],
		};
		getMemberThread.mockResolvedValue(Ok(thread));

		const record = (await threadsConnector.get(threads, 'thread-1')).unwrap();

		expect(getMemberThread).toHaveBeenCalledWith({orgId: 'org-1', userId: 'user-1'}, 'thread-1', ['send_to_person']);
		expect(getThreadAddress).toHaveBeenCalledWith(thread);
		expect(record).toEqual({
			id: 'thread-1',
			values: {
				title: 'Pricing review with Dana',
				agent: 'Finance',
				place: 'Chat',
				standing: 'Waiting for you',
				summary: 'Asks which day suits Dana.',
				lastMessageAt: at(2).toISOString(),
				messages: 'Person: Move the pricing review\n\nAgent: Which day suits Dana?',
			},
			updatedAt: at(2).toISOString(),
			url: 'https://app.example.test/acme/chat/persona-1/threads/thread-1',
		});

		// One that lives in Slack says so, and its url is its thread there.
		getThreadAddress.mockResolvedValue(Ok({orgSlug: 'acme', personaName: 'Finance', slack: SLACK}));
		const inSlack = (await threadsConnector.get(threads, 'thread-1')).unwrap();
		expect(inSlack.values.place).toBe('Slack');
		expect(inSlack.url).toBe(SLACK_URL);

		getMemberThread.mockResolvedValue(Ok(null));
		expect((await threadsConnector.get(threads, 'thread-9')).unwrapErr()).toMatchObject({kind: 'not_found', resource: 'record'});
	});
});

describe('the Chat connection’s threads in Slack', () => {
	test('say a thread that lives in Slack is there, its url its thread in Slack, which the app doesn’t show', async () => {
		const {threadsConnector} = await import('./connector');
		listMemberThreads.mockResolvedValue(Ok({orgSlug: 'acme', threads: [listed({id: 'in-slack', slack: SLACK}), listed({id: 'in-chat'})]}));

		const {records} = (await threadsConnector.list(threads, all)).unwrap();

		expect(records.map(({id, values, url}) => [id, values.place, url])).toEqual([
			['in-slack', 'Slack', SLACK_URL],
			['in-chat', 'Chat', 'https://app.example.test/acme/chat/persona-1/threads/in-chat'],
		]);
	});
});

describe('where one of the Chat connection’s threads stands', () => {
	const stopped: ChatThreadRow = {
		id: 'thread-1',
		orgId: 'org-1',
		agentId: 'login-1',
		personaId: 'persona-1',
		userId: 'user-1',
		parentThreadId: 'chat-1',
		subAgentOfId: null,
		parentCallId: null,
		title: 'Pricing review with Dana',
		taskId: 'task-1',
		harness: null,
		harnessSession: null,
		openedByAlert: false,
		createdAt: at(0),
		state: {kind: 'stopped'},
		standing: {waitingForMember: false, summary: 'Moved it to Friday.', summarySeq: 0, archived: true},
		alerts: 0,
		entries: [],
		attachments: [],
		subAgents: [],
	};

	beforeEach(() => {
		getMemberThread.mockResolvedValue(Ok(stopped));
		changeMemberThreadStanding.mockResolvedValue(Ok('changed'));
	});

	test('is changed as the member’s, done, archived or brought back, and answered with the thread as it is then', async () => {
		const {threadsConnector} = await import('./connector');

		const archived = (await threadsConnector.commands.archive(threads, 'thread-1')).unwrap();
		expect(changeMemberThreadStanding).toHaveBeenCalledWith({orgId: 'org-1', userId: 'user-1'}, 'thread-1', 'archive');
		expect(archived?.values.standing).toBe('Archived');

		(await threadsConnector.commands.markDone(threads, 'thread-1')).unwrap();
		expect(changeMemberThreadStanding).toHaveBeenLastCalledWith({orgId: 'org-1', userId: 'user-1'}, 'thread-1', 'done');
		(await threadsConnector.commands.unarchive(threads, 'thread-1')).unwrap();
		expect(changeMemberThreadStanding).toHaveBeenLastCalledWith({orgId: 'org-1', userId: 'user-1'}, 'thread-1', 'unarchive');
	});

	test('is refused for one taken up since it was read, or watching for one to archive, and not found for one that isn’t the member’s', async () => {
		const {threadsConnector} = await import('./connector');

		changeMemberThreadStanding.mockResolvedValue(Ok('in_progress'));
		expect((await threadsConnector.commands.archive(threads, 'thread-1')).unwrapErr()).toMatchObject({kind: 'validation_error', message: expect.stringContaining('in progress')});

		changeMemberThreadStanding.mockResolvedValue(Ok('watching'));
		expect((await threadsConnector.commands.archive(threads, 'thread-1')).unwrapErr()).toMatchObject({kind: 'validation_error', message: expect.stringContaining('cancel the alerts')});

		changeMemberThreadStanding.mockResolvedValue(Ok(null));
		expect((await threadsConnector.commands.markDone(threads, 'thread-9')).unwrapErr()).toMatchObject({kind: 'not_found', resource: 'record'});
		expect(getMemberThread).not.toHaveBeenCalled();
	});

	test('is told of in a line in the record’s words, as a thread’s agent reads the person’s other threads', async () => {
		const {threadLine} = await import('./connector');

		expect(threadLine(listed({slack: SLACK}))).toBe('thread-1: “Pricing review with Dana” with Finance, in Slack, Waiting for you: Asks which day suits Dana.');
		expect(threadLine(listed({id: 'thread-2', title: 'Book the train to Lyon', state: {kind: 'working'}, last: {seq: 3, pending: false, createdAt: at(3)}}))).toBe(
			'thread-2: “Book the train to Lyon” with Finance, in Chat, In progress',
		);
	});
});

describe('a message sent to one of the Chat connection’s threads', () => {
	const entry = (id: string, seq: number, text: string, passedOn: ShownEntryRow['passedOn'] = null): ShownEntryRow => ({
		id,
		seq,
		kind: 'person',
		text,
		pending: false,
		toolCalls: null,
		callId: null,
		isError: false,
		passedOn,
		createdAt: at(seq),
	});
	const target: ChatThreadRow = {
		id: 'thread-2',
		orgId: 'org-1',
		agentId: 'login-1',
		personaId: 'persona-2',
		userId: 'user-1',
		parentThreadId: 'chat-2',
		subAgentOfId: null,
		parentCallId: null,
		title: 'Upgrade vite',
		taskId: 'task-2',
		harness: null,
		harnessSession: null,
		openedByAlert: false,
		createdAt: at(0),
		state: {kind: 'working'},
		standing: {waitingForMember: false, summary: null, summarySeq: null, archived: false},
		alerts: 0,
		entries: [
			entry('e1', 1, 'Upgrade vite to 7'),
			entry('e2', 2, 'Yes, include the docs site too', {threadId: 'thread-1', thread: {id: 'thread-1', personaId: 'persona-1', title: 'Pricing review with Dana', slack: null}}),
			entry('e3', 3, 'And the website', {threadId: 'thread-0', thread: null}),
		],
		attachments: [],
		subAgents: [],
	};
	// The member's Chat as an agent's call reaches it, for the task of one of its threads.
	const fromThread = {...threads, by: {agentId: 'login-1', taskId: 'task-1'}};

	beforeEach(() => {
		getMemberThread.mockResolvedValue(Ok(target));
		passOnToThread.mockResolvedValue(Ok({sent: {id: 'e2'}}));
	});

	test('is passed on as the member’s from the thread whose task the call is, and answered with the thread it went to, by its url', async () => {
		const {threadsConnector} = await import('./connector');

		const record = (await threadsConnector.commands.send(fromThread, 'thread-2', {text: '  Yes, include the docs site too '})).unwrap();

		expect(passOnToThread).toHaveBeenCalledWith({orgId: 'org-1', userId: 'user-1'}, 'task-1', 'thread-2', 'Yes, include the docs site too', expect.any(Function));
		expect(record?.url).toBe('https://app.example.test/acme/chat/persona-2/threads/thread-2');
	});

	test('says in its record which of what the member said was passed on, and from where', async () => {
		const {threadsConnector} = await import('./connector');

		const record = (await threadsConnector.get(threads, 'thread-2')).unwrap();

		expect(record.values.messages?.split('\n\n')).toEqual([
			'Person: Upgrade vite to 7',
			'Person (passed on from thread thread-1, “Pricing review with Dana”): Yes, include the docs site too',
			'Person (passed on from another thread, deleted since): And the website',
		]);
	});

	test('is refused in plain words for a call no thread’s agent makes, a sub-agent’s, to the thread itself, and from a thread whose latest message was passed on to it', async () => {
		const {threadsConnector} = await import('./connector');

		// A member on a page, and a sweep, make no call for a task.
		for (const caller of [threads, {...threads, by: {userId: 'user-1'}}]) {
			expect((await threadsConnector.commands.send(caller, 'thread-2', {text: 'Hello'})).unwrapErr()).toMatchObject({
				kind: 'validation_error',
				message: expect.stringContaining('Only the agent of one of your threads'),
			});
		}
		expect(passOnToThread).not.toHaveBeenCalled();

		passOnToThread.mockResolvedValue(Ok({refused: 'not_a_thread'}));
		expect((await threadsConnector.commands.send(fromThread, 'thread-2', {text: 'Hello'})).unwrapErr()).toMatchObject({message: expect.stringContaining('Only the agent of one of your threads')});
		passOnToThread.mockResolvedValue(Ok({refused: 'sub_agent'}));
		expect((await threadsConnector.commands.send(fromThread, 'thread-2', {text: 'Hello'})).unwrapErr()).toMatchObject({message: expect.stringContaining('tell the agent you work for')});
		passOnToThread.mockResolvedValue(Ok({refused: 'itself'}));
		expect((await threadsConnector.commands.send(fromThread, 'thread-1', {text: 'Hello'})).unwrapErr()).toMatchObject({message: expect.stringContaining('That is this thread')});
		passOnToThread.mockResolvedValue(Ok({refused: 'passed_on'}));
		expect((await threadsConnector.commands.send(fromThread, 'thread-2', {text: 'Hello'})).unwrapErr()).toMatchObject({message: expect.stringContaining('until you write in it directly')});
		passOnToThread.mockResolvedValue(Ok(null));
		expect((await threadsConnector.commands.send(fromThread, 'thread-9', {text: 'Hello'})).unwrapErr()).toMatchObject({kind: 'not_found', resource: 'record'});
	});

	test('is refused without words, or with more than a message holds', async () => {
		const {threadsConnector} = await import('./connector');

		expect((await threadsConnector.commands.send(fromThread, 'thread-2', {text: '   '})).unwrapErr()).toMatchObject({kind: 'validation_error'});
		expect((await threadsConnector.commands.send(fromThread, 'thread-2', {text: 'a'.repeat(20_001)})).unwrapErr()).toMatchObject({kind: 'validation_error'});
		expect(passOnToThread).not.toHaveBeenCalled();
	});
});

describe('a thread one of the Chat connection’s threads opens', () => {
	const look = {nose: 0.5, noseOut: 0.3, eye: 25, eyeTheta: 50, eyeLat: 8, eyes: 2 as const};
	const persona = (id: string, name: string) => ({id, name, look, color: 'teal', harness: 'proxy', chatModel: 'claude', ownerUserId: null, createdById: null, createdAt: at(0)});
	const sending = {
		id: 'thread-1',
		orgId: 'org-1',
		agentId: 'login-1',
		personaId: 'persona-1',
		userId: 'user-1',
		parentThreadId: 'chat-1',
		subAgentOfId: null,
		parentCallId: null,
		title: 'Pricing review with Dana',
		taskId: 'task-1',
		harness: null,
		harnessSession: null,
		openedByAlert: false,
		createdAt: at(0),
	};
	const chat = {...sending, id: 'chat-2', personaId: 'persona-2', parentThreadId: null, title: null, taskId: null};
	const opened: ChatThreadRow = {
		...sending,
		id: 'thread-3',
		personaId: 'persona-2',
		parentThreadId: 'chat-2',
		title: 'Draft the renewal email to Northwind',
		taskId: 'task-3',
		state: {kind: 'working'},
		standing: {waitingForMember: false, summary: null, summarySeq: null, archived: false},
		alerts: 0,
		entries: [],
		attachments: [],
		subAgents: [],
	};
	const fromThread = {...threads, by: {agentId: 'login-1', taskId: 'task-1'}};
	const inSlack = {appId: 'app-1', channel: 'D0001'};

	beforeEach(() => {
		getPassingThread.mockResolvedValue(Ok({thread: sending, slack: null}));
		getPersona.mockResolvedValue(Ok(persona('persona-1', 'Finance')));
		findMemberPersonas.mockResolvedValue(Ok([persona('persona-2', 'Legal')]));
		ensureChat.mockResolvedValue(Ok(chat));
		openPassedOnThread.mockResolvedValue(Ok({opened: {thread: opened, entry: {id: 'e9'}, placeId: null}}));
		getMemberThread.mockResolvedValue(Ok(opened));
		getThreadAddress.mockResolvedValue(Ok({orgSlug: 'acme', personaName: 'Legal', slack: null}));
		slackOpening.mockResolvedValue(Ok(inSlack));
	});

	test('takes its message, its agent and its place, none of them a thread’s field', () => {
		const open = threads.collection.commands?.find((command) => command.id === 'open');
		expect(open).toMatchObject({on: 'new', action: 'writeThreads'});
		expect(open?.params?.map(({key}) => key)).toEqual(['text', 'agent', 'place']);
		expect(open?.params?.find(({key}) => key === 'place')?.options).toEqual(['Chat', 'Slack']);
	});

	test('is opened in Chat with the named agent, its message the member’s passed on, its title and task cut from it, and answered with it by its page', async () => {
		const {threadsConnector} = await import('./connector');

		const record = (await threadsConnector.newCommands.open(fromThread, {text: ' Draft the renewal email to Northwind ', agent: ' legal ', place: ''})).unwrap();

		expect(findMemberPersonas).toHaveBeenCalledWith('org-1', 'user-1', 'legal');
		expect(ensureChat).toHaveBeenCalledWith(expect.anything(), {orgId: 'org-1', userId: 'user-1'}, persona('persona-2', 'Legal'));
		expect(openPassedOnThread).toHaveBeenCalledWith(
			{orgId: 'org-1', userId: 'user-1'},
			'task-1',
			{chatId: 'chat-2', text: 'Draft the renewal email to Northwind', opening: expect.objectContaining({title: 'Draft the renewal email to Northwind'}), slack: null},
			expect.any(Function),
		);
		expect(slackOpening).not.toHaveBeenCalled();
		expect(deliverNow).not.toHaveBeenCalled();
		expect(record).toMatchObject({id: 'thread-3', values: {agent: 'Legal', place: 'Chat'}, url: 'https://app.example.test/acme/chat/persona-2/threads/thread-3'});
	});

	test('is with the sending thread’s agent and in its place where neither is asked for: in Slack for one from Slack, posted there at once', async () => {
		const {threadsConnector} = await import('./connector');
		getPassingThread.mockResolvedValue(Ok({thread: sending, slack: inSlack}));
		openPassedOnThread.mockResolvedValue(Ok({opened: {thread: opened, entry: {id: 'e9'}, placeId: 'place-3'}}));
		getThreadAddress.mockResolvedValue(Ok({orgSlug: 'acme', personaName: 'Finance', slack: {teamId: 'T0001', channel: 'D0001', rootTs: null}}));

		const record = (await threadsConnector.newCommands.open(fromThread, {text: 'Draft the renewal email', agent: '', place: ''})).unwrap();

		expect(getPersona).toHaveBeenCalledWith('org-1', 'user-1', 'persona-1');
		expect(findMemberPersonas).not.toHaveBeenCalled();
		expect(slackOpening).toHaveBeenCalledWith({orgId: 'org-1', userId: 'user-1'}, persona('persona-1', 'Finance'), inSlack);
		expect(openPassedOnThread.mock.calls[0]?.[2]).toMatchObject({slack: inSlack});
		expect(deliverNow).toHaveBeenCalledWith('place-3', 'https://app.example.test');
		// Its root message not posted yet, its url is the DM it is to be in.
		expect(record).toMatchObject({values: {place: 'Slack'}, url: 'https://app.slack.com/client/T0001/D0001'});
	});

	test('is in the other place where it is asked for: in Chat from Slack, in Slack from Chat', async () => {
		const {threadsConnector} = await import('./connector');

		getPassingThread.mockResolvedValue(Ok({thread: sending, slack: inSlack}));
		(await threadsConnector.newCommands.open(fromThread, {text: 'Open this in the app', agent: '', place: 'Chat'})).unwrap();
		expect(slackOpening).not.toHaveBeenCalled();
		expect(openPassedOnThread.mock.calls[0]?.[2]).toMatchObject({slack: null});

		getPassingThread.mockResolvedValue(Ok({thread: sending, slack: null}));
		(await threadsConnector.newCommands.open(fromThread, {text: 'Start this in Slack', agent: '', place: 'Slack'})).unwrap();
		expect(slackOpening).toHaveBeenCalledWith({orgId: 'org-1', userId: 'user-1'}, persona('persona-1', 'Finance'), null);
		expect(openPassedOnThread.mock.calls[1]?.[2]).toMatchObject({slack: inSlack});
	});

	test('is refused in plain words from a caller that is no thread, a sub-agent, along a chain, for an agent that isn’t the member’s, and where Slack can’t have it', async () => {
		const {threadsConnector} = await import('./connector');
		const open = (values: Record<string, string>, target: typeof fromThread | typeof threads = fromThread) =>
			threadsConnector.newCommands.open(target, {text: 'Draft it', agent: '', place: '', ...values});

		expect((await open({}, threads)).unwrapErr()).toMatchObject({kind: 'validation_error', message: expect.stringContaining('Only the agent of one of your threads')});
		expect(getPassingThread).not.toHaveBeenCalled();

		getPassingThread.mockResolvedValueOnce(Ok({refused: 'sub_agent'}));
		expect((await open({})).unwrapErr()).toMatchObject({message: expect.stringContaining('tell the agent you work for')});
		getPassingThread.mockResolvedValueOnce(Ok({refused: 'passed_on'}));
		expect((await open({})).unwrapErr()).toMatchObject({message: expect.stringContaining('until you write in it directly')});

		findMemberPersonas.mockResolvedValueOnce(Ok([]));
		expect((await open({agent: 'Ops'})).unwrapErr()).toMatchObject({message: 'You have no agent called “Ops”: name one of yours, by its name or id'});
		findMemberPersonas.mockResolvedValueOnce(Ok([persona('persona-2', 'Legal'), persona('persona-3', 'Legal')]));
		expect((await open({agent: 'Legal'})).unwrapErr()).toMatchObject({message: expect.stringContaining('name it by its id')});
		getPersona.mockResolvedValueOnce(Ok(null));
		expect((await open({})).unwrapErr()).toMatchObject({message: expect.stringContaining('no longer one you talk to')});

		slackOpening.mockResolvedValueOnce(Err(ApiErr.validationError('Finance isn’t in Slack')));
		expect((await open({place: 'Slack'})).unwrapErr()).toMatchObject({message: 'Finance isn’t in Slack'});

		openPassedOnThread.mockResolvedValueOnce(Ok({refused: 'passed_on'}));
		expect((await open({})).unwrapErr()).toMatchObject({message: expect.stringContaining('until you write in it directly')});

		expect((await open({text: '  '})).unwrapErr()).toMatchObject({kind: 'validation_error', message: 'Give the message as text'});
		expect(openPassedOnThread).toHaveBeenCalledTimes(1);
		expect(deliverNow).not.toHaveBeenCalled();
	});
});

describe('the Chat connection’s alerts', () => {
	const look = {nose: 0.5, noseOut: 0.3, eye: 25, eyeTheta: 50, eyeLat: 8, eyes: 2 as const};
	const alert: MemberAlertRow = {
		id: 'alert-1',
		orgId: 'org-1',
		userId: 'user-1',
		chatId: 'chat-1',
		threadId: 'thread-2',
		setInThreadId: 'thread-2',
		title: 'Morning check',
		brief: 'See whether Dana moved the review.',
		at: at(30),
		nextAt: at(30),
		every: null,
		timeZone: null,
		collectionId: null,
		connectionIds: [],
		terms: [],
		split: null,
		lastMatchedAt: null,
		slackAppId: null,
		slackChannel: null,
		createdAt: at(0),
		persona: {id: 'persona-1', name: 'Finance', look, color: 'teal', harness: 'proxy', chatModel: 'claude', ownerUserId: null, createdById: null, createdAt: at(0)},
		thread: {id: 'thread-2', title: 'Check the review every morning', slack: null},
		setIn: {id: 'thread-2', title: 'Check the review every morning', slack: null},
	};
	const record = {
		id: 'alert-1',
		values: {title: 'Morning check', comes: 'due 2026-10-21T10:30:00.000Z', note: 'See whether Dana moved the review.', thread: 'Check the review every morning', agent: 'Finance'},
		updatedAt: at(0).toISOString(),
		url: 'https://app.example.test/acme/chat/persona-1/threads/thread-2',
	};

	beforeEach(() => {
		listMemberAlerts.mockResolvedValue(Ok([alert]));
	});

	test('are every one the member has, each with when it comes, its note and the thread it comes to, by its page', async () => {
		const {alertsConnector} = await import('./connector');

		expect((await alertsConnector.list(alerts, all)).unwrap()).toEqual({records: [record], nextPage: null});
		expect(listMemberAlerts).toHaveBeenCalledWith('org-1', 'user-1');
		expect((await alertsConnector.get(alerts, 'alert-1')).unwrap()).toEqual(record);
		expect((await alertsConnector.get(alerts, 'alert-9')).unwrapErr()).toMatchObject({kind: 'not_found', resource: 'record'});
		expect((await alertsConnector.list(alerts, {...all, page: '2'})).unwrapErr().kind).toBe('validation_error');

		listMemberAlerts.mockResolvedValue(Ok([]));
		expect((await alertsConnector.list(alerts, all)).unwrap()).toEqual({records: [], nextPage: null});
	});

	test('link one that comes to a thread in Slack, or opens new threads and was set in one, to that thread there', async () => {
		const {alertsConnector} = await import('./connector');
		const inSlack = {id: 'thread-2', title: 'Check the review every morning', slack: SLACK};
		listMemberAlerts.mockResolvedValue(
			Ok([
				{...alert, thread: inSlack, setIn: inSlack},
				{...alert, id: 'alert-2', threadId: null, thread: null, setIn: inSlack, slackAppId: 'app-1', slackChannel: 'D0001'},
				{...alert, id: 'alert-3', threadId: null, thread: null},
			]),
		);

		const {records} = (await alertsConnector.list(alerts, all)).unwrap();

		expect(records.map(({id, url}) => [id, url])).toEqual([
			['alert-1', SLACK_URL],
			['alert-2', SLACK_URL],
			['alert-3', 'https://app.example.test/acme/chat/persona-1/threads/thread-2'],
		]);
		// One set in a Slack thread opens its new threads there; one set in the app, in the app.
		expect(records.map(({values}) => values.thread)).toEqual(['Check the review every morning', 'A new thread in Slack each time', 'A new thread each time']);
	});

	test('are cancelled as the member’s, whichever thread one was set in', async () => {
		const {alertsConnector} = await import('./connector');
		deleteAlert.mockResolvedValue(Ok(true));

		expect((await alertsConnector.remove(alerts, 'alert-1')).isOk()).toBe(true);
		expect(deleteAlert).toHaveBeenCalledWith('alert-1', {orgId: 'org-1', userId: 'user-1'});

		deleteAlert.mockResolvedValue(Ok(false));
		expect((await alertsConnector.remove(alerts, 'alert-9')).unwrapErr()).toMatchObject({kind: 'not_found', resource: 'record'});
	});
});
