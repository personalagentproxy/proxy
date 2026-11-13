import {readdirSync, readFileSync} from 'node:fs';

import {PGlite} from '@electric-sql/pglite';
import {afterAll, beforeAll, describe, expect, test} from 'bun:test';

// The migration that reshapes the chats from before threads (v063), run on old-shaped rows: a
// database of its own, in this process, which PGlite, the embedded Postgres the local database
// runs on too, keeps in memory, made with every migration before it, so the test holds whatever the
// schema becomes after. Nothing here needs the local database. The rows are read as db/harness.ts
// reads a chat's threads (listChatThreads), in SQL, since its client knows only the schema of now.
const MIGRATION = 'v063_reshape_chats_into_threads';

const migrations = new URL('../prisma/migrations/', import.meta.url);

function migrationSql(name: string): string {
	return readFileSync(new URL(`${name}/migration.sql`, migrations), 'utf8');
}

// Prisma applies the migrations in the order their names sort as text (migrations.test.ts).
const before = readdirSync(migrations, {withFileTypes: true})
	.filter((entry) => entry.isDirectory() && entry.name < MIGRATION)
	.map((entry) => entry.name)
	.sort();

type Value = string | number | boolean | null;

const pg = new PGlite();

async function insert(table: string, row: Record<string, Value>): Promise<void> {
	const columns = Object.keys(row);
	await pg.query(
		`INSERT INTO "${table}" (${columns.map((column) => `"${column}"`).join(', ')}) VALUES (${columns.map((_, index) => `$${index + 1}`).join(', ')})`,
		Object.values(row),
	);
}

async function rows<T>(sql: string, params: Value[] = []): Promise<T[]> {
	return (await pg.query<T>(sql, params)).rows;
}

// A time as a column without a time zone keeps it, and as it reads as text: the UTC wall clock,
// as Prisma writes one.
function wallClock(time: Date): string {
	return time.toISOString().slice(0, 19).replace('T', ' ');
}

// A time of the fixtures', `seconds` after the first.
function at(seconds: number): string {
	return wallClock(new Date(Date.UTC(2026, 2, 2, 9, 0, seconds)));
}

type Call = {id: string; name: string; arguments: string};

function calls(...made: Call[]): string {
	return JSON.stringify(made);
}

const script = (id: string): Call => ({id, name: 'script', arguments: '{"code":"return 1"}'});
const toParent = (id: string, text: string): Call => ({
	id,
	name: 'send_to_parent',
	arguments: JSON.stringify({text}),
});
const createSubAgent = (id: string, title: string): Call => ({
	id,
	name: 'create_subagent',
	arguments: JSON.stringify({title, brief: title}),
});
const toSubAgent = (id: string, text: string): Call => ({
	id,
	name: 'send_to_subagent',
	arguments: JSON.stringify({subagent: 'task-1', text}),
});

// An entry of a thread's log at `seq`, written at a time in the same order.
async function entry(
	threadId: string,
	seq: number,
	fields: Record<string, Value> & {kind: string},
): Promise<string> {
	const id = `e${seq}`;
	await insert('AgentEntry', {id, seq, threadId, text: '', createdAt: at(seq), ...fields});
	return id;
}

async function file(
	threadId: string,
	entryId: string | null,
	name: string,
	position = 0,
): Promise<void> {
	await insert('AgentEntryAttachment', {
		id: `file-${threadId}-${entryId ?? 'input'}-${name}`,
		entryId,
		threadId,
		position,
		connectionId: 'drive',
		fileId: name,
		version: `${name}-v1`,
		name,
		type: 'application/pdf',
		size: 1200,
		text: null,
		createdAt: at(0),
	});
}

async function task(id: string, title: string, fields: Record<string, Value> = {}): Promise<void> {
	await insert('AgentTask', {
		id,
		orgId: 'org',
		agentId: 'agent',
		ownerUserId: 'dana',
		personaId: 'general',
		title,
		goal: title,
		via: 'harness',
		createdAt: at(0),
		lastActiveAt: at(0),
		...fields,
	});
}

async function thread(id: string, fields: Record<string, Value>): Promise<void> {
	await insert('AgentThread', {
		id,
		orgId: 'org',
		agentId: 'agent',
		personaId: 'general',
		userId: 'dana',
		createdAt: at(0),
		...fields,
	});
}

async function job(
	id: string,
	threadId: string,
	fields: Record<string, Value> & {kind: string},
): Promise<void> {
	await insert('AgentJob', {id, threadId, ...fields});
}

// The old shape: Dana's chat with General, where the main agent started two sub-agents, one on her
// message, one on an alert; Sam's with General; and two chats of Dana's that are no old
// conversation, one empty, one with a thread of the new code only.
async function seed(): Promise<void> {
	await insert('User', {id: 'dana', email: 'dana@example.com'});
	await insert('User', {id: 'sam', email: 'sam@example.com'});
	await insert('Organization', {id: 'org', name: 'Example', slug: 'example', ownerUserId: 'dana'});
	await insert('Agent', {
		id: 'agent',
		orgId: 'org',
		name: 'Built-in',
		username: 'built-in',
		passwordHash: '-',
		providerId: 'built-in',
	});
	await insert('Persona', {
		id: 'general',
		orgId: 'org',
		name: 'General',
		look: '{}',
		color: 'blue',
	});
	await insert('Persona', {id: 'writer', orgId: 'org', name: 'Writer', look: '{}', color: 'green'});

	// Dana's chat with General: what she typed and hasn't sent, a file in its input, her read
	// marker, a session of the SDK's and an alert.
	await thread('chat-a', {
		draft: 'Half a thought',
		readSeq: 192,
		harness: 'claude-agent-sdk',
		harnessSession: JSON.stringify({id: 'session-a', state: {lastSeq: 150, job: 'job-a1'}}),
	});
	await file('chat-a', null, 'agenda.pdf');
	await insert('AgentAlert', {
		id: 'alert-a',
		orgId: 'org',
		userId: 'dana',
		threadId: 'chat-a',
		title: 'Weekly report',
		brief: 'Remind Dana of the weekly report',
		at: at(5000),
		nextAt: at(5000),
	});
	await insert('AgentHarnessTranscript', {
		id: 'line-a',
		projectKey: 'threads-chat-a',
		sessionId: 'session-a',
		entry: '{"type":"user"}',
	});
	await insert('AgentHarnessTranscript', {
		id: 'line-a-sub',
		projectKey: 'threads-chat-a',
		sessionId: 'session-a',
		subpath: 'subagents/one',
		entry: '{"type":"user"}',
	});
	await insert('AgentHarnessTranscript', {
		id: 'line-other',
		projectKey: 'threads-other',
		sessionId: 'session-other',
		entry: '{"type":"user"}',
	});

	// The sub-agent Dana's message started, pinned, at work, with a sub-task under way, and the one
	// an alert did, done.
	await task('task-pricing', 'Pricing review', {lastActiveAt: wallClock(new Date())});
	await task('task-pricing-sub', 'Read the drive', {
		parentId: 'task-pricing',
		lastActiveAt: wallClock(new Date()),
	});
	await task('task-report', 'Weekly report', {
		finishedAt: at(143),
		lastActiveAt: at(143),
		outcome: 'Drafted it.',
	});
	await thread('task-1', {
		parentThreadId: 'chat-a',
		parentCallId: 'call-1',
		title: 'Pricing review',
		taskId: 'task-pricing',
		pinnedAt: at(150),
		harness: 'claude-agent-sdk',
		harnessSession: '{"id":"session-t1","state":{}}',
	});
	await thread('task-2', {
		parentThreadId: 'chat-a',
		parentCallId: 'call-2',
		title: 'Weekly report',
		taskId: 'task-report',
		harness: 'proxy',
		harnessSession: 'not json',
	});
	// A thread the new code opened in the chat already.
	await task('task-new', 'Plan the offsite');
	await thread('thread-new', {
		parentThreadId: 'chat-a',
		title: 'Plan the offsite',
		taskId: 'task-new',
	});

	const p1 = await entry('chat-a', 100, {
		kind: 'person',
		text: 'Find the pricing review with Dana ￼',
	});
	await file('chat-a', p1, 'pricing.pdf');
	await file('chat-a', p1, 'pricing-notes.txt', 1);
	await entry('chat-a', 110, {
		kind: 'assistant',
		toolCalls: calls(createSubAgent('call-1', 'Pricing review')),
		jobId: 'job-a0',
	});
	await entry('task-1', 111, {
		kind: 'person',
		text: 'Look for the pricing review notes in the shared drive.',
	});
	await entry('chat-a', 112, {
		kind: 'tool_result',
		callId: 'call-1',
		text: 'Started “Pricing review”, id task-1.',
	});
	await entry('task-1', 113, {
		kind: 'assistant',
		text: 'Searching.',
		toolCalls: calls(toParent('t1-c1', 'Found two candidates.'), script('t1-c2')),
	});
	await entry('task-1', 114, {kind: 'tool_result', callId: 't1-c1', text: 'Sent.'});
	await entry('task-1', 115, {kind: 'tool_result', callId: 't1-c2', text: '1'});
	await entry('task-1', 116, {
		kind: 'assistant',
		toolCalls: calls(
			toParent('t1-c3', '  The second one is it.\n'),
			{id: 't1-c4', name: 'send_to_parent', arguments: '{not json'},
			toParent('t1-c5', '   '),
		),
	});
	await entry('task-1', 117, {kind: 'tool_result', callId: 't1-c3', text: 'Sent.'});
	await entry('task-1', 118, {kind: 'assistant', toolCalls: calls(script('t1-c6'))});
	await entry('task-1', 119, {kind: 'tool_result', callId: 't1-c6', text: '1'});
	await entry('chat-a', 120, {
		kind: 'assistant',
		text: 'I asked a helper to look.',
		jobId: 'job-a0',
	});
	await entry('chat-a', 130, {kind: 'event', text: 'Weekly report is due.'});
	await entry('chat-a', 140, {
		kind: 'assistant',
		toolCalls: calls(createSubAgent('call-2', 'Weekly report')),
	});
	await entry('task-2', 141, {kind: 'person', text: 'Draft the weekly report.'});
	await entry('chat-a', 142, {
		kind: 'tool_result',
		callId: 'call-2',
		text: 'Started “Weekly report”, id task-2.',
	});
	await entry('task-2', 143, {kind: 'assistant', text: 'Drafted it.'});
	await entry('chat-a', 150, {kind: 'person', text: 'Also check the budget sheet'});
	await entry('chat-a', 160, {
		kind: 'assistant',
		toolCalls: calls(
			toSubAgent('call-3', 'Please also check the budget sheet.'),
			toSubAgent('call-4', 'And mind the budget totals.'),
		),
	});
	await entry('task-1', 161, {kind: 'person', text: 'Please also check the budget sheet.'});
	await entry('task-1', 162, {kind: 'person', text: 'And mind the budget totals.'});
	await entry('chat-a', 163, {kind: 'tool_result', callId: 'call-3', text: 'Sent.'});
	await entry('chat-a', 164, {kind: 'tool_result', callId: 'call-4', text: 'Sent.'});
	await entry('chat-a', 170, {
		kind: 'event',
		callId: 'call-2',
		text: 'Drafted it.\n\n(It has stopped; a message takes it up again.)',
	});
	await entry('chat-a', 180, {
		kind: 'assistant',
		toolCalls: calls(toSubAgent('call-5', 'The report is drafted; carry on.')),
	});
	await entry('task-1', 181, {kind: 'person', text: 'The report is drafted; carry on.'});
	await entry('chat-a', 182, {kind: 'tool_result', callId: 'call-5', text: 'Sent.'});
	await entry('task-1', 190, {kind: 'person', text: 'Use the March numbers', direct: true});
	await file('task-1', 'e190', 'march.csv');
	const note = await entry('chat-a', 191, {
		kind: 'note',
		callId: 'call-1',
		text: 'Use the March numbers',
	});
	await file('chat-a', note, 'march.csv');
	await entry('task-1', 192, {kind: 'assistant', text: 'Using March.', jobId: 'job-t1-done'});
	await entry('chat-a', 200, {
		kind: 'summary',
		text: 'Dana asked for the pricing review.',
		coversSeq: 120,
	});
	await entry('chat-a', 210, {kind: 'person', text: 'Are you there?', pending: true});
	await entry('task-1', 205, {kind: 'person', text: 'One more thing', direct: true, pending: true});
	await entry('thread-new', 220, {kind: 'person', text: 'Plan the offsite'});

	// Work in flight: the conversation's turn, running; a tool job of the sub-agent's, queued, and
	// one done; a wake-up of the other's.
	await job('job-a1', 'chat-a', {
		kind: 'inference',
		status: 'running',
		claimedBy: 'worker-1',
		leaseExpiresAt: at(9000),
		attempts: 1,
	});
	await job('job-t1-tool', 'task-1', {
		kind: 'tool',
		status: 'queued',
		entryId: 'e118',
		callId: 't1-c6',
	});
	await job('job-t1-done', 'task-1', {
		kind: 'tool',
		status: 'done',
		entryId: 'e113',
		callId: 't1-c2',
	});
	await job('job-t2-wake', 'task-2', {kind: 'wake', status: 'queued', runAt: at(9000)});
	await job('job-new', 'thread-new', {kind: 'inference', status: 'queued'});

	// Sam's chat with General, which is his alone.
	await thread('chat-b', {userId: 'sam', readSeq: 301});
	await entry('chat-b', 300, {kind: 'person', text: 'Hello from Sam'});
	await entry('chat-b', 301, {kind: 'assistant', text: 'Hi Sam.'});

	// Dana's chat with Writer, empty but for what she typed, and her chat with another persona the
	// new code began, with one thread.
	await thread('chat-c', {personaId: 'writer', draft: 'Untouched draft'});
	await file('chat-c', null, 'outline.pdf');
	await insert('User', {id: 'lee', email: 'lee@example.com'});
	await thread('chat-d', {userId: 'lee'});
	await task('task-d', 'Book a room');
	await thread('thread-d', {
		userId: 'lee',
		parentThreadId: 'chat-d',
		title: 'Book a room',
		taskId: 'task-d',
	});
	await entry('thread-d', 400, {kind: 'person', text: 'Book a room'});

	// The sequence on, as the rows written through it would have left it.
	await pg.query(`SELECT setval(pg_get_serial_sequence('"AgentEntry"', 'seq'), 400)`);
}

type ThreadRecord = {
	id: string;
	parentThreadId: string | null;
	parentCallId: string | null;
	userId: string;
	personaId: string;
	title: string | null;
	taskId: string | null;
	draft: string | null;
	readSeq: number;
	harness: string | null;
	harnessSession: string | null;
	createdAt: Date;
};

type EntryRecord = {
	id: string;
	seq: number;
	kind: string;
	text: string;
	toolCalls: string | null;
	callId: string | null;
	direct: boolean;
	pending: boolean;
	jobId: string | null;
};

const threadColumns = `"id", "parentThreadId", "parentCallId", "userId", "personaId", "title", "taskId", "draft", "readSeq", "harness", "harnessSession", "createdAt"`;

function threadRow(id: string): Promise<ThreadRecord | undefined> {
	return rows<ThreadRecord>(`SELECT ${threadColumns} FROM "AgentThread" WHERE "id" = $1`, [
		id,
	]).then((found) => found[0]);
}

function chatOf(userId: string, personaId: string): Promise<ThreadRecord[]> {
	return rows<ThreadRecord>(
		`SELECT ${threadColumns} FROM "AgentThread" WHERE "userId" = $1 AND "personaId" = $2 AND "parentThreadId" IS NULL`,
		[userId, personaId],
	);
}

function entriesOf(threadId: string): Promise<EntryRecord[]> {
	return rows<EntryRecord>(
		`SELECT "id", "seq", "kind", "text", "toolCalls", "callId", "direct", "pending", "jobId" FROM "AgentEntry" WHERE "threadId" = $1 ORDER BY "pending", "seq"`,
		[threadId],
	);
}

function filesOf(
	entryId: string,
): Promise<Array<{threadId: string; fileId: string; position: number}>> {
	return rows(
		`SELECT "threadId", "fileId", "position" FROM "AgentEntryAttachment" WHERE "entryId" = $1 ORDER BY "position"`,
		[entryId],
	);
}

// A chat's threads as listChatThreads reads them: its children no call started, oldest first, with
// what of each the member sees (shownInThread, no call shown): what was said, the events, what the
// agent answered in words, in order, what is pending last, and its open jobs.
type ListedThread = {
	id: string;
	title: string | null;
	shown: Array<{kind: string; text: string; createdAt: string}>;
	openJobs: number;
};

async function listChatThreads(chatId: string): Promise<ListedThread[]> {
	const threads = await rows<{id: string; title: string | null}>(
		`SELECT "id", "title" FROM "AgentThread" WHERE "parentThreadId" = $1 AND "parentCallId" IS NULL ORDER BY "createdAt", "id"`,
		[chatId],
	);
	return Promise.all(
		threads.map(async (listed) => ({
			...listed,
			shown: await rows<{kind: string; text: string; createdAt: string}>(
				`SELECT "kind", "text", "createdAt"::text AS "createdAt" FROM "AgentEntry"
				WHERE "threadId" = $1 AND ("kind" IN ('person', 'event') OR ("kind" = 'assistant' AND "text" <> ''))
				ORDER BY "pending", "seq"`,
				[listed.id],
			),
			openJobs:
				(
					await rows<{count: number}>(
						`SELECT count(*)::int AS "count" FROM "AgentJob" WHERE "threadId" = $1 AND "status" IN ('queued', 'running')`,
						[listed.id],
					)
				)[0]?.count ?? 0,
		})),
	);
}

let chatC: ThreadRecord | undefined;
let chatCFiles: Array<{threadId: string; fileId: string; position: number}> = [];
let threadD: EntryRecord[] = [];
let newChat: ThreadRecord;
let maxSeqBefore = 0;

beforeAll(async () => {
	for (const name of before) {
		await pg.exec(migrationSql(name));
	}
	await seed();
	chatC = await threadRow('chat-c');
	chatCFiles = await rows(
		`SELECT "threadId", "fileId", "position" FROM "AgentEntryAttachment" WHERE "threadId" = 'chat-c'`,
	);
	threadD = await entriesOf('thread-d');
	maxSeqBefore =
		(await rows<{max: number}>(`SELECT max("seq") AS "max" FROM "AgentEntry"`))[0]?.max ?? 0;
	await pg.exec(migrationSql(MIGRATION));
	const [chat] = await chatOf('dana', 'general');
	if (!chat) {
		throw new Error('Dana has no chat with General');
	}
	newChat = chat;
}, 120_000);

afterAll(async () => {
	await pg.close();
});

describe('the chat', () => {
	test('a new, empty chat takes the old one’s place, with its draft, its input and its read marker', async () => {
		expect(await chatOf('dana', 'general')).toHaveLength(1);
		expect(newChat.id).not.toBe('chat-a');
		expect(newChat).toMatchObject({
			parentThreadId: null,
			parentCallId: null,
			title: null,
			taskId: null,
			draft: 'Half a thought',
			readSeq: 192,
			harness: null,
			harnessSession: null,
		});
		expect(await entriesOf(newChat.id)).toEqual([]);
		expect(
			await rows(`SELECT "fileId", "entryId" FROM "AgentEntryAttachment" WHERE "threadId" = $1`, [
				newChat.id,
			]),
		).toEqual([{fileId: 'agenda.pdf', entryId: null}]);
	});

	test('lists the old conversation, its sub-agents and the threads it had already as its threads', async () => {
		const listed = await listChatThreads(newChat.id);
		expect(listed.map((one) => [one.id, one.title])).toEqual([
			['chat-a', 'Earlier conversation'],
			['task-1', 'Pricing review'],
			['task-2', 'Weekly report'],
			['thread-new', 'Plan the offsite'],
		]);
	});
});

describe('the old conversation', () => {
	test('is a thread of the new chat, with a finished task of its own', async () => {
		const old = await threadRow('chat-a');
		expect(old).toMatchObject({
			parentThreadId: newChat.id,
			parentCallId: null,
			title: 'Earlier conversation',
			draft: null,
			readSeq: 0,
			harness: null,
			harnessSession: null,
		});
		const [own] = await rows<{
			title: string;
			finishedAt: Date | null;
			ownerUserId: string;
			personaId: string;
			parentId: string | null;
			lastActiveAt: Date;
		}>(
			`SELECT "title", "finishedAt", "ownerUserId", "personaId", "parentId", "lastActiveAt" FROM "AgentTask" WHERE "id" = $1`,
			[old?.taskId ?? ''],
		);
		expect(own).toMatchObject({
			title: 'Earlier conversation',
			ownerUserId: 'dana',
			personaId: 'general',
			parentId: null,
		});
		expect(own?.finishedAt).not.toBeNull();
	});

	test('keeps what was said, the alert’s event and the summary, without the calls, the reports or the notes', async () => {
		const kept = await entriesOf('chat-a');
		expect(kept.map(({kind, text}) => [kind, text])).toEqual([
			['person', 'Find the pricing review with Dana ￼'],
			['assistant', 'I asked a helper to look.'],
			['event', 'Weekly report is due.'],
			['person', 'Also check the budget sheet'],
			['summary', 'Dana asked for the pricing review.'],
			['person', 'Are you there?'],
		]);
		expect(kept.every((one) => one.toolCalls === null && one.callId === null && !one.pending)).toBe(
			true,
		);
		expect(await filesOf('e100')).toEqual([
			{threadId: 'chat-a', fileId: 'pricing.pdf', position: 0},
			{threadId: 'chat-a', fileId: 'pricing-notes.txt', position: 1},
		]);
		expect(
			await rows(
				`SELECT "id" FROM "AgentEntryAttachment" WHERE "fileId" = 'march.csv' AND "threadId" = 'chat-a'`,
			),
		).toEqual([]);
	});

	test('what was pending takes its place at the end, after everything there was', async () => {
		const [released] = (await entriesOf('chat-a')).filter((one) => one.text === 'Are you there?');
		expect(released?.pending).toBe(false);
		expect(released?.seq).toBeGreaterThan(maxSeqBefore);
	});

	test('keeps its alert', async () => {
		expect(await rows(`SELECT "threadId" FROM "AgentAlert" WHERE "id" = 'alert-a'`)).toEqual([
			{threadId: 'chat-a'},
		]);
	});

	test('reads as the chat lists a thread: opened by the member, its messages counted, the last when it came', async () => {
		const listed = (await listChatThreads(newChat.id)).find((one) => one.id === 'chat-a');
		expect(listed?.shown[0]).toMatchObject({
			kind: 'person',
			text: 'Find the pricing review with Dana ￼',
		});
		expect(listed?.shown).toHaveLength(5);
		expect(listed?.shown.at(-1)?.createdAt).toBe(at(210));
	});
});

describe('the sub-agent the member’s message started', () => {
	test('is a thread of the new chat that keeps its title and its task', async () => {
		expect(await threadRow('task-1')).toMatchObject({
			parentThreadId: newChat.id,
			parentCallId: null,
			title: 'Pricing review',
			taskId: 'task-pricing',
			harness: null,
			harnessSession: null,
		});
	});

	test('opens with what the member said, with their files, takes their follow-up once, and keeps what they wrote in it and its notes as what it said', async () => {
		const kept = await entriesOf('task-1');
		expect(kept.map(({kind, text}) => [kind, text])).toEqual([
			['person', 'Find the pricing review with Dana ￼'],
			['assistant', 'Searching.\n\nFound two candidates.'],
			['assistant', 'The second one is it.'],
			['person', 'Also check the budget sheet'],
			['person', 'Use the March numbers'],
			['assistant', 'Using March.'],
			['person', 'One more thing'],
		]);
		expect(kept[0]?.id).toBe('e111');
		expect(kept[3]?.id).toBe('e161');
		expect(
			kept.every(
				(one) => one.toolCalls === null && one.callId === null && !one.direct && !one.pending,
			),
		).toBe(true);
		expect(kept.filter((one) => one.kind === 'person').every((one) => one.jobId === null)).toBe(
			true,
		);
		expect(await filesOf('e111')).toEqual([
			{threadId: 'task-1', fileId: 'pricing.pdf', position: 0},
			{threadId: 'task-1', fileId: 'pricing-notes.txt', position: 1},
		]);
		expect(await filesOf('e161')).toEqual([]);
		expect(await filesOf('e190')).toEqual([{threadId: 'task-1', fileId: 'march.csv', position: 0}]);
	});

	test('the member’s message it opens with is what the chat lists it by', async () => {
		const listed = (await listChatThreads(newChat.id)).find((one) => one.id === 'task-1');
		expect(listed?.shown[0]).toMatchObject({
			kind: 'person',
			text: 'Find the pricing review with Dana ￼',
		});
		expect(listed?.shown).toHaveLength(7);
	});

	test('its task and the sub-task under it are finished, and nothing of it is at work', async () => {
		const tasks = await rows<{id: string; finishedAt: Date | null}>(
			`SELECT "id", "finishedAt" FROM "AgentTask" WHERE "id" IN ('task-pricing', 'task-pricing-sub')`,
		);
		expect(tasks).toHaveLength(2);
		expect(tasks.every((one) => one.finishedAt !== null)).toBe(true);
		expect((await listChatThreads(newChat.id)).find((one) => one.id === 'task-1')?.openJobs).toBe(
			0,
		);
	});
});

describe('the sub-agent an alert started', () => {
	test('opens with its brief as an event, and keeps its finished task as it was', async () => {
		const kept = await entriesOf('task-2');
		expect(kept.map(({kind, text}) => [kind, text])).toEqual([
			['event', 'Draft the weekly report.'],
			['assistant', 'Drafted it.'],
		]);
		expect(
			await rows(
				`SELECT "finishedAt"::text AS "finishedAt", "outcome" FROM "AgentTask" WHERE "id" = 'task-report'`,
			),
		).toEqual([{finishedAt: at(143), outcome: 'Drafted it.'}]);
		expect(await threadRow('task-2')).toMatchObject({
			parentThreadId: newChat.id,
			parentCallId: null,
			harness: null,
			harnessSession: null,
		});
	});
});

describe('the work in flight', () => {
	test('every open job of a reshaped thread failed, noted as failed, and a tool job names no call', async () => {
		const jobs = await rows<{
			id: string;
			status: string;
			error: string | null;
			claimedBy: string | null;
			leaseExpiresAt: Date | null;
			entryId: string | null;
			callId: string | null;
		}>(
			`SELECT "id", "status", "error", "claimedBy", "leaseExpiresAt", "entryId", "callId" FROM "AgentJob" WHERE "threadId" IN ('chat-a', 'task-1', 'task-2') ORDER BY "id"`,
		);
		const closed = {
			status: 'failed',
			error: 'The chat moved to threads before this job ran',
			claimedBy: null,
			leaseExpiresAt: null,
		};
		expect(jobs).toEqual([
			{id: 'job-a1', ...closed, entryId: null, callId: null},
			{
				id: 'job-t1-done',
				status: 'done',
				error: null,
				claimedBy: null,
				leaseExpiresAt: null,
				entryId: null,
				callId: null,
			},
			{id: 'job-t1-tool', ...closed, entryId: null, callId: null},
			{id: 'job-t2-wake', ...closed, entryId: null, callId: null},
		]);
		expect(
			await rows(
				`SELECT "jobId", "threadId", "kind", "workerId" FROM "AgentJobEvent" ORDER BY "jobId"`,
			),
		).toEqual([
			{jobId: 'job-a1', threadId: 'chat-a', kind: 'failed', workerId: null},
			{jobId: 'job-t1-tool', threadId: 'task-1', kind: 'failed', workerId: null},
			{jobId: 'job-t2-wake', threadId: 'task-2', kind: 'failed', workerId: null},
		]);
	});

	test('the threads’ model memory is gone, and no other session’s', async () => {
		expect(await rows(`SELECT "id" FROM "AgentHarnessTranscript" ORDER BY "id"`)).toEqual([
			{id: 'line-other'},
		]);
	});
});

describe('what was no old conversation', () => {
	test('a thread the new code opened goes with the chat as it was, its work going on', async () => {
		const moved = await threadRow('thread-new');
		expect(moved).toMatchObject({
			parentThreadId: newChat.id,
			parentCallId: null,
			title: 'Plan the offsite',
			taskId: 'task-new',
		});
		expect((await entriesOf('thread-new')).map(({kind, text}) => [kind, text])).toEqual([
			['person', 'Plan the offsite'],
		]);
		expect(await rows(`SELECT "status" FROM "AgentJob" WHERE "id" = 'job-new'`)).toEqual([
			{status: 'queued'},
		]);
	});

	test('an empty chat is left as it was', async () => {
		expect(await threadRow('chat-c')).toEqual(chatC);
		expect(await chatOf('dana', 'writer')).toHaveLength(1);
		expect(
			await rows(
				`SELECT "threadId", "fileId", "position" FROM "AgentEntryAttachment" WHERE "fileId" = 'outline.pdf'`,
			),
		).toEqual(chatCFiles);
	});

	test('a chat of the new code alone is left as it was', async () => {
		expect(await chatOf('lee', 'general')).toEqual([expect.objectContaining({id: 'chat-d'})]);
		expect(await threadRow('thread-d')).toMatchObject({parentThreadId: 'chat-d'});
		expect(await entriesOf('thread-d')).toEqual(threadD);
	});
});

describe('another member’s chat', () => {
	test('is reshaped on its own: nothing of one member’s crosses to the other’s', async () => {
		const [sams] = await chatOf('sam', 'general');
		expect(sams).toMatchObject({userId: 'sam', readSeq: 301, draft: null});
		expect(sams?.id).not.toBe(newChat.id);
		const listed = await listChatThreads(sams?.id ?? '');
		expect(listed.map((one) => [one.id, one.title, one.shown.map(({text}) => text)])).toEqual([
			['chat-b', 'Earlier conversation', ['Hello from Sam', 'Hi Sam.']],
		]);
		const [own] = await rows<{ownerUserId: string}>(
			`SELECT task."ownerUserId" FROM "AgentTask" AS task JOIN "AgentThread" AS t ON t."taskId" = task."id" WHERE t."id" = 'chat-b'`,
		);
		expect(own?.ownerUserId).toBe('sam');
		const danas = await rows<{userId: string}>(
			`SELECT DISTINCT "userId" FROM "AgentThread" WHERE "parentThreadId" = $1`,
			[newChat.id],
		);
		expect(danas).toEqual([{userId: 'dana'}]);
	});
});
