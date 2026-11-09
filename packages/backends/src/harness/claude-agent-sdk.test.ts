import {randomUUID} from 'node:crypto';
import {existsSync, mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import type {NonNullableUsage, Options, SDKAssistantMessage, SDKMessage, SDKResultError, SDKResultSuccess} from '@anthropic-ai/claude-agent-sdk';
import type {BetaContentBlock} from '@anthropic-ai/sdk/resources/beta/messages';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {afterEach, describe, expect, test} from 'bun:test';
import {Err, Ok} from 'ts-results-es';

import {ApiErr} from '@proxy/utils';
import {CALL_INTERRUPTED, RUN_INTERRUPTED} from '@proxy/utils/harness';
import type {ContextEntry} from '@proxy/utils/harness-context';

import type {HarnessEvent, HarnessTurn} from './backend';
import {claudeAgentSdkHarness, type ClaudeAgentSdkDeps, proxyToolServer, type SdkQuery} from './claude-agent-sdk';
import {harnessConformance, type ScriptedModel} from './conformance';
import {fakeToolSurface} from './fake';
import {memorySessionStore} from './session-store';

// The SDK as the tests stand in for it: a `query` that records what it was given and yields the
// messages a script says, the script given the options so it can reach the MCP server the harness
// built, as the binary would; or one that fails to start.
type Script = ((options: Options | undefined) => AsyncIterable<SDKMessage>) | {throws: Error};

type FakeQuery = {
	query: SdkQuery;
	calls: Array<{prompt: string; options: Options | undefined}>;
	interrupts: number;
	script: (run: Script) => void;
};

function fakeQuery(): FakeQuery {
	const scripts: Script[] = [];
	const fake: FakeQuery = {
		calls: [],
		interrupts: 0,
		script: (run) => {
			scripts.push(run);
		},
		query: ({prompt, options}) => {
			fake.calls.push({prompt, options});
			const run = scripts.shift() ?? messages([]);
			if ('throws' in run) {
				throw run.throws;
			}
			return Object.assign(run(options), {
				interrupt: async () => {
					fake.interrupts += 1;
				},
			});
		},
	};
	return fake;
}

function messages(list: SDKMessage[]): Script {
	return async function* () {
		yield* list;
	};
}

// A run whose stream fails after `list`, as when the subprocess dies.
function failing(list: SDKMessage[], error: Error): Script {
	return async function* () {
		yield* list;
		throw error;
	};
}

const SESSION = 'session-1';

function usage(input: number, output: number, cache: {read: number; creation: number} = {read: 0, creation: 0}): NonNullableUsage {
	return {
		cache_creation: {ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: cache.creation},
		cache_creation_input_tokens: cache.creation,
		cache_read_input_tokens: cache.read,
		fallback_credit: null,
		inference_geo: 'us',
		input_tokens: input,
		iterations: [],
		output_tokens: output,
		output_tokens_details: {thinking_tokens: 0},
		server_tool_use: {web_fetch_requests: 0, web_search_requests: 0},
		service_tier: 'standard',
		speed: 'standard',
	};
}

function init(): SDKMessage {
	return {
		type: 'system',
		subtype: 'init',
		apiKeySource: 'none',
		claude_code_version: '2.1.0',
		cwd: '/tmp/work',
		tools: [],
		mcp_servers: [{name: 'proxy', status: 'connected', source: 'sdk'}],
		model: 'claude-sonnet-5-5',
		permissionMode: 'default',
		slash_commands: [],
		output_style: 'default',
		skills: [],
		plugins: [],
		uuid: randomUUID(),
		session_id: SESSION,
	};
}

function textBlock(text: string): BetaContentBlock {
	return {type: 'text', text, citations: null};
}

function toolUse(call: {id: string; name: string; arguments: string}): BetaContentBlock {
	const input: unknown = JSON.parse(call.arguments);
	return {type: 'tool_use', id: call.id, name: `mcp__proxy__${call.name}`, input};
}

function assistant(content: BetaContentBlock[], extra: Partial<Pick<SDKAssistantMessage, 'error' | 'parent_tool_use_id'>> = {}): SDKMessage {
	return {
		type: 'assistant',
		message: {
			id: 'msg_1',
			type: 'message',
			role: 'assistant',
			model: 'claude-sonnet-5-5',
			content,
			stop_reason: 'end_turn',
			stop_sequence: null,
			container: null,
			context_management: null,
			diagnostics: null,
			stop_details: null,
			usage: usage(1, 1),
		},
		parent_tool_use_id: null,
		uuid: randomUUID(),
		session_id: SESSION,
		...extra,
	};
}

function toolResult(callId: string, text: string, isError = false, parent: string | null = null): SDKMessage {
	return {
		type: 'user',
		message: {role: 'user', content: [{type: 'tool_result', tool_use_id: callId, content: text, is_error: isError}]},
		parent_tool_use_id: parent,
		session_id: SESSION,
	};
}

function result(extra: Partial<SDKResultSuccess> = {}): SDKMessage {
	return {
		type: 'result',
		subtype: 'success',
		duration_ms: 1,
		duration_api_ms: 1,
		is_error: false,
		num_turns: 1,
		result: '',
		stop_reason: 'end_turn',
		total_cost_usd: 0,
		usage: usage(10, 2),
		modelUsage: {},
		permission_denials: [],
		uuid: randomUUID(),
		session_id: SESSION,
		...extra,
	};
}

function errorResult(subtype: SDKResultError['subtype'], errors: string[]): SDKMessage {
	return {
		type: 'result',
		subtype,
		duration_ms: 1,
		duration_api_ms: 1,
		is_error: true,
		num_turns: 1,
		stop_reason: null,
		total_cost_usd: 0,
		usage: usage(10, 2),
		modelUsage: {},
		permission_denials: [],
		errors,
		uuid: randomUUID(),
		session_id: SESSION,
	};
}

// A client on the MCP server the harness gave the SDK, as the binary has one.
async function connect(options: Options | undefined): Promise<Client> {
	const config = options?.mcpServers?.proxy;
	if (config === undefined || !('instance' in config)) {
		throw new Error('The harness gave the SDK no proxy server');
	}
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	await config.instance.connect(serverTransport);
	const client = new Client({name: 'test', version: '0'});
	await client.connect(clientTransport);
	return client;
}

// The model as the binary reports it: one answer with its calls, each run through the harness's
// MCP server as the binary runs them and echoed as a user message with the result, then the result.
function answering(answer: {text: string; toolCalls: Array<{id: string; name: string; arguments: string}>}): Script {
	return async function* (options) {
		yield init();
		yield assistant([...(answer.text === '' ? [] : [textBlock(answer.text)]), ...answer.toolCalls.map(toolUse)]);
		if (answer.toolCalls.length > 0) {
			const client = await connect(options);
			for (const call of answer.toolCalls) {
				const input: unknown = JSON.parse(call.arguments);
				const called = await client.callTool({name: call.name, arguments: typeof input === 'object' && input !== null ? {...input} : {}, _meta: {'claudecode/toolUseId': call.id}});
				const content = Array.isArray(called.content) ? called.content : [];
				const text = content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n');
				yield toolResult(call.id, text, called.isError === true);
			}
		}
		yield result();
	};
}

const workDir = mkdtempSync(join(tmpdir(), 'proxy-harness-test-'));

function deps(fake: FakeQuery, extra: Partial<ClaudeAgentSdkDeps> = {}): ClaudeAgentSdkDeps {
	return {sessionStore: memorySessionStore(), workDir, configDir: join(workDir, 'config'), maxConcurrentTurns: 1, query: fake.query, ...extra};
}

harnessConformance('the Claude Agent SDK harness', () => {
	const fake = fakeQuery();
	const harness = claudeAgentSdkHarness(deps(fake));
	const scripted: ScriptedModel = {
		answers: (answer) => {
			fake.script(answering(answer));
		},
		unreachable: () => {
			fake.script({throws: new Error('spawn ENOENT')});
		},
	};
	return {harness, scripted};
});

const TOOLS = [
	{name: 'read', description: 'Reads', inputSchema: {type: 'object', properties: {a: {type: 'number'}}}, readOnly: true},
	{name: 'sleep_until', description: 'Sleeps', inputSchema: {type: 'object', properties: {seconds: {type: 'number'}}}, readOnly: false},
];

let seq = 0;

function entry(kind: ContextEntry['kind'], text: string, extra: Partial<Pick<ContextEntry, 'toolCalls' | 'callId' | 'isError' | 'coversSeq'>> = {}): ContextEntry {
	seq += 1;
	return {kind, text, toolCalls: extra.toolCalls ?? null, callId: extra.callId ?? null, isError: extra.isError ?? false, seq, coversSeq: extra.coversSeq ?? null, inputTokens: null};
}

function turnInput(extra: Partial<HarnessTurn> = {}): HarnessTurn {
	return {
		thread: {id: 'thread-1', parentThreadId: null},
		auth: {kind: 'api_key', key: 'test-key'},
		session: null,
		entries: [entry('person', 'Hi')],
		subAgents: [],
		woken: false,
		system: 'You are a test.',
		tools: fakeToolSurface(TOOLS),
		model: 'claude',
		maxSteps: 7,
		signal: new AbortController().signal,
		...extra,
	};
}

async function collect(fake: FakeQuery, input: HarnessTurn, extra: Partial<ClaudeAgentSdkDeps> = {}): Promise<HarnessEvent[]> {
	return Array.fromAsync(claudeAgentSdkHarness(deps(fake, extra)).turn(input));
}

describe('claudeAgentSdkHarness', () => {
	afterEach(() => {
		delete process.env.OPENROUTER_KEY;
	});

	test('is a harness that answers its calls itself, capped on turns at once', () => {
		const harness = claudeAgentSdkHarness(deps(fakeQuery(), {maxConcurrentTurns: 3}));

		expect(harness).toMatchObject({id: 'claude-agent-sdk', stepsPerTurn: 'many', maxConcurrentTurns: 3});
	});

	test('fails at once without a credential, as one turned down, and asks the SDK nothing', async () => {
		const fake = fakeQuery();

		const events = await collect(fake, {...turnInput(), auth: undefined});

		expect(events).toEqual([{kind: 'failed', error: ApiErr.credentialsRejected(), retry: false}]);
		expect(fake.calls).toEqual([]);
	});

	test('builds the subprocess environment from the credential and inherits nothing but PATH and HOME', async () => {
		process.env.OPENROUTER_KEY = 'the-server-key';
		const fake = fakeQuery();
		fake.script(messages([init(), result()]));
		fake.script(messages([init(), result()]));
		fake.script(messages([init(), result()]));

		await collect(fake, {...turnInput(), auth: {kind: 'oauth', accessToken: 'oat-1', scopes: ['user:profile', 'user:inference']}});
		await collect(fake, {...turnInput(), auth: {kind: 'oauth', accessToken: 'oat-2', scopes: []}});
		await collect(fake, {...turnInput(), auth: {kind: 'api_key', key: 'key-3'}});

		const [withScopes, withoutScopes, apiKey] = fake.calls.map((call) => call.options?.env);
		expect(withScopes).toEqual({
			...(process.env.PATH === undefined ? {} : {PATH: process.env.PATH}),
			...(process.env.HOME === undefined ? {} : {HOME: process.env.HOME}),
			CLAUDE_CONFIG_DIR: join(workDir, 'config'),
			CLAUDE_CODE_PROJECT_DIR_NAME: 'thread-1',
			CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
			CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS: '1',
			CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
			DISABLE_TELEMETRY: '1',
			CLAUDE_CODE_OAUTH_TOKEN: 'oat-1',
			CLAUDE_CODE_OAUTH_SCOPES: 'user:profile user:inference',
		});
		expect(withoutScopes).toMatchObject({CLAUDE_CODE_OAUTH_TOKEN: 'oat-2'});
		expect(withoutScopes).not.toHaveProperty('CLAUDE_CODE_OAUTH_SCOPES');
		expect(withoutScopes).not.toHaveProperty('ANTHROPIC_API_KEY');
		expect(apiKey).toMatchObject({ANTHROPIC_API_KEY: 'key-3'});
		expect(apiKey).not.toHaveProperty('CLAUDE_CODE_OAUTH_TOKEN');
		for (const env of [withScopes, withoutScopes, apiKey]) {
			expect(env).not.toHaveProperty('OPENROUTER_KEY');
		}
	});

	test('prompts with what came since the session last saw the log, resumes the session, and keeps the last seq', async () => {
		const fake = fakeQuery();
		fake.script(messages([init(), result()]));
		const seen = entry('person', 'Hi');
		const step = entry('assistant', 'Looking.', {
			toolCalls: [
				{id: 'c1', name: 'read', arguments: '{}'},
				{id: 'c2', name: 'create_subagent', arguments: '{}'},
			],
		});
		const started = entry('tool_result', 'Started sa1.', {callId: 'c2'});
		const refused = entry('tool_result', 'No such connection.', {callId: 'c1', isError: true});
		const said = entry('event', 'Found it.', {callId: 'c2'});
		const summary = entry('summary', 'Earlier: hi.', {coversSeq: seen.seq});
		const again = entry('person', 'And then?');

		const events = await collect(fake, {
			...turnInput(),
			session: {id: 'sdk-session-9', state: {lastSeq: seen.seq}},
			entries: [seen, step, started, refused, said, summary, again],
			subAgents: [{id: 'sa1', parentCallId: 'c2', title: 'Finder'}],
		});

		expect(fake.calls[0]?.prompt).toBe(
			['A message from the sub-agent “Finder” (id sa1). The person did not write this; it is for you to act on or tell them of.\n\nFound it.', 'And then?'].join('\n\n'),
		);
		expect(fake.calls[0]?.options?.resume).toBe('sdk-session-9');
		expect(events.at(-1)).toMatchObject({kind: 'done', session: {id: SESSION, state: {lastSeq: again.seq}}});
	});

	test('leaves a previous turn’s own results out of the prompt, and tells of a call the api closed as interrupted', async () => {
		const fake = fakeQuery();
		fake.script(messages([init(), result()]));
		const seen = entry('person', 'Hi');
		const step = entry('assistant', '', {
			toolCalls: [
				{id: 'c1', name: 'read', arguments: '{}'},
				{id: 'c2', name: 'run', arguments: '{}'},
				{id: 'c3', name: 'read', arguments: '{}'},
			],
		});
		const answered = entry('tool_result', 'rows', {callId: 'c1'});
		const unknown = entry('tool_result', RUN_INTERRUPTED, {callId: 'c2', isError: true});
		const unanswered = entry('tool_result', CALL_INTERRUPTED, {callId: 'c3', isError: true});

		await collect(fake, {...turnInput(), session: {id: 's', state: {lastSeq: seen.seq}}, entries: [seen, step, answered, unknown, unanswered]});

		expect(fake.calls[0]?.prompt).toBe([`Your call c2 (run) was not answered: ${RUN_INTERRUPTED}`, `Your call c3 (read) was not answered: ${CALL_INTERRUPTED}`].join('\n\n'));
	});

	test('says so when woken, says to go on when nothing is new, and starts afresh on a session that isn’t one', async () => {
		const fake = fakeQuery();
		fake.script(messages([init(), result()]));
		fake.script(messages([init(), result()]));
		fake.script(messages([init(), result()]));
		const hi = entry('person', 'Hi');
		const answered = entry('assistant', 'Hello.');

		await collect(fake, {...turnInput(), session: {id: 's', state: {lastSeq: answered.seq}}, entries: [hi, answered], woken: true});
		await collect(fake, {...turnInput(), session: {id: 's', state: {lastSeq: answered.seq}}, entries: [hi, answered]});
		await collect(fake, {...turnInput(), session: {id: 's', state: {seqs: 'what'}}, entries: [hi, answered]});

		expect(fake.calls[0]?.prompt).toMatch(/^You were woken, and it is now \d{4}-\d{2}-\d{2}T[\d:.]+Z\.$/);
		expect(fake.calls[1]?.prompt).toBe('Go on.');
		expect(fake.calls[2]?.prompt).toBe('Hi');
		expect(fake.calls[2]?.options).not.toHaveProperty('resume');
	});

	test('gives the SDK no built-in tools, the api’s tools on an MCP server pre-approved, a directory per thread, the step cap, the session store and Sonnet', async () => {
		const fake = fakeQuery();
		fake.script(messages([init(), result()]));
		fake.script(messages([init(), result()]));
		const sessionStore = memorySessionStore();

		await collect(fake, turnInput(), {sessionStore, pathToClaudeCodeExecutable: '/opt/claude'});
		await collect(fake, {...turnInput(), model: 'glm-5', thread: {id: 'thread-2', parentThreadId: 'thread-1'}});

		const options = fake.calls[0]?.options;
		expect(options).toMatchObject({
			systemPrompt: 'You are a test.',
			tools: [],
			allowedTools: expect.arrayContaining(['mcp__proxy__*']),
			permissionMode: 'default',
			settingSources: [],
			strictMcpConfig: true,
			maxTurns: 7,
			cwd: join(workDir, 'thread-1'),
			pathToClaudeCodeExecutable: '/opt/claude',
			model: 'sonnet',
		});
		expect(options?.sessionStore).toBe(sessionStore);
		expect(options?.mcpServers?.proxy).toMatchObject({type: 'sdk', name: 'proxy'});
		expect(options?.abortController).toBeInstanceOf(AbortController);
		expect(existsSync(join(workDir, 'thread-1'))).toBe(true);
		expect(fake.calls[1]?.options).toMatchObject({model: 'sonnet', cwd: join(workDir, 'thread-2')});
		expect(fake.calls[1]?.options).not.toHaveProperty('pathToClaudeCodeExecutable');
	});

	test('denies any tool but the proxy server’s', async () => {
		const fake = fakeQuery();
		fake.script(messages([init(), result()]));

		await collect(fake, turnInput());
		const canUseTool = fake.calls[0]?.options?.canUseTool;
		if (canUseTool === undefined) {
			throw new Error('No canUseTool');
		}
		const ask = (name: string, server?: {name: string; source: string}) =>
			canUseTool(name, {}, {signal: new AbortController().signal, toolUseID: 'toolu_1', requestId: 'r1', ...(server === undefined ? {} : {mcpServer: server})});

		expect(await ask('mcp__proxy__read', {name: 'proxy', source: 'sdk'})).toEqual({behavior: 'allow'});
		expect(await ask('mcp__proxy__read')).toEqual({behavior: 'allow'});
		expect(await ask('Bash')).toMatchObject({behavior: 'deny', message: expect.stringContaining('Bash is not available here')});
		expect(await ask('mcp__proxy__read', {name: 'proxy', source: 'project'})).toMatchObject({behavior: 'deny'});
	});

	test('maps the binary’s messages to events in order, the input counted with the cache, ignoring sub-agents’ and results for calls it didn’t make', async () => {
		const fake = fakeQuery();
		fake.script(
			messages([
				init(),
				assistant([textBlock('Looking.'), toolUse({id: 'c1', name: 'read', arguments: '{"a":1}'})]),
				assistant([textBlock('Inside a sub-agent')], {parent_tool_use_id: 'other'}),
				toolResult('c1', 'rows'),
				toolResult('c0', 'from a replay'),
				toolResult('c1', 'again, inside', false, 'other'),
				assistant([textBlock(''), textBlock('Done.')]),
				result({usage: usage(10, 3, {read: 5, creation: 2})}),
			]),
		);

		const input = turnInput();
		const events = await collect(fake, input);

		expect(events).toEqual([
			{kind: 'text', text: 'Looking.'},
			{kind: 'tool_call', id: 'c1', name: 'read', arguments: '{"a":1}'},
			{kind: 'tool_result', callId: 'c1', text: 'rows', isError: false},
			{kind: 'text', text: 'Done.'},
			{kind: 'done', session: {id: SESSION, state: {lastSeq: input.entries[0]?.seq ?? 0}}, system: 'You are a test.', inputTokens: 17, outputTokens: 3},
		]);
	});

	test('ends with the credential turned down on an authentication error, and with the model out of reach on a rate limit', async () => {
		const fake = fakeQuery();
		fake.script(messages([init(), assistant([textBlock('Invalid authentication')], {error: 'authentication_failed'}), result({is_error: true, result: 'Invalid authentication'})]));
		fake.script(messages([init(), assistant([], {error: 'billing_error'}), result({is_error: true})]));
		fake.script(messages([init(), assistant([], {error: 'rate_limit'}), result({is_error: true})]));

		expect(await collect(fake, turnInput())).toEqual([{kind: 'failed', error: ApiErr.credentialsRejected(), retry: false}]);
		expect(await collect(fake, turnInput())).toEqual([{kind: 'failed', error: ApiErr.credentialsRejected(), retry: false}]);
		expect(await collect(fake, turnInput())).toMatchObject([{kind: 'failed', error: {kind: 'provider_unreachable'}, retry: true}]);
	});

	test('reads a result that is an error: out of reach is worth trying again, a refusal is not, and the cap on steps is done', async () => {
		const fake = fakeQuery();
		fake.script(messages([init(), result({is_error: true, result: 'API Error: 529 Overloaded'})]));
		fake.script(messages([init(), errorResult('error_during_execution', ['The request was refused'])]));
		fake.script(messages([init(), assistant([textBlock('Still going')]), errorResult('error_max_turns', [])]));

		expect(await collect(fake, turnInput())).toMatchObject([{kind: 'failed', error: {kind: 'provider_unreachable', cause: new Error('API Error: 529 Overloaded')}, retry: true}]);
		expect(await collect(fake, turnInput())).toMatchObject([{kind: 'failed', error: {kind: 'internal_error', cause: new Error('The request was refused')}, retry: false}]);
		expect(await collect(fake, turnInput())).toMatchObject([
			{kind: 'text', text: 'Still going'},
			{kind: 'done', inputTokens: 10, outputTokens: 2},
		]);
	});

	test('a query that fails to start, or dies mid-way, ends the turn as the model out of reach, worth trying again', async () => {
		const fake = fakeQuery();
		const missing = new Error('Claude Code executable not found');
		const died = new Error('The process exited with code 1');
		fake.script({throws: missing});
		fake.script(failing([init(), assistant([textBlock('Half')])], died));
		fake.script(messages([init()]));

		expect(await collect(fake, turnInput())).toEqual([{kind: 'failed', error: ApiErr.providerUnreachable(missing), retry: true}]);
		expect(await collect(fake, turnInput())).toEqual([
			{kind: 'text', text: 'Half'},
			{kind: 'failed', error: ApiErr.providerUnreachable(died), retry: true},
		]);
		expect(await collect(fake, turnInput())).toMatchObject([{kind: 'failed', error: {kind: 'provider_unreachable'}, retry: true}]);
	});

	test('runs a call through the surface with its arguments as JSON, and interrupts the query after one that ends the turn', async () => {
		const fake = fakeQuery();
		const surface = fakeToolSurface(TOOLS, {text: 'Sleeping until then.', isError: false, endTurn: true});
		fake.script(answering({text: 'Back in a bit.', toolCalls: [{id: 'c1', name: 'sleep_until', arguments: '{"seconds":5}'}]}));

		const events = await collect(fake, {...turnInput(), tools: surface});

		expect(surface.calls).toEqual([{id: 'c1', name: 'sleep_until', arguments: '{"seconds":5}'}]);
		expect(events).toMatchObject([
			{kind: 'text', text: 'Back in a bit.'},
			{kind: 'tool_call', id: 'c1', name: 'sleep_until', arguments: '{"seconds":5}'},
			{kind: 'tool_result', callId: 'c1', text: 'Sleeping until then.', isError: false},
			{kind: 'done'},
		]);
		expect(fake.interrupts).toBe(1);
	});

	test('a turn interrupted after a sleep is done whatever the result says', async () => {
		const fake = fakeQuery();
		const surface = fakeToolSurface(TOOLS, {text: 'Sleeping.', isError: false, endTurn: true});
		fake.script(async function* (options) {
			yield init();
			yield assistant([toolUse({id: 'c1', name: 'sleep_until', arguments: '{"seconds":5}'})]);
			const client = await connect(options);
			await client.callTool({name: 'sleep_until', arguments: {seconds: 5}, _meta: {'claudecode/toolUseId': 'c1'}});
			yield toolResult('c1', 'Sleeping.');
			yield errorResult('error_during_execution', ['Interrupted']);
		});

		const events = await collect(fake, {...turnInput(), tools: surface});

		expect(events.at(-1)).toMatchObject({kind: 'done', session: {id: SESSION}});
		expect(fake.interrupts).toBe(1);
	});

	test('a call the surface can’t run is answered as an error, without interrupting', async () => {
		const fake = fakeQuery();
		const surface = {tools: TOOLS, execute: async () => Err(ApiErr.unavailable('The gate is closed'))};
		fake.script(answering({text: '', toolCalls: [{id: 'c1', name: 'read', arguments: '{}'}]}));

		const events = await collect(fake, {...turnInput(), tools: surface});

		expect(events).toMatchObject([{kind: 'tool_call', id: 'c1'}, {kind: 'tool_result', callId: 'c1', text: 'The gate is closed', isError: true}, {kind: 'done'}]);
		expect(fake.interrupts).toBe(0);
	});
});

describe('proxyToolServer', () => {
	async function serve(execute: Parameters<typeof proxyToolServer>[0]['execute'], answered: Parameters<typeof proxyToolServer>[1] = () => {}): Promise<Client> {
		const server = proxyToolServer({tools: TOOLS, execute}, answered);
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		await server.connect(serverTransport);
		const client = new Client({name: 'test', version: '0'});
		await client.connect(clientTransport);
		return client;
	}

	test('lists the tools with their JSON Schema as given, whether each only reads, and marked to be loaded always', async () => {
		const client = await serve(async () => Ok({text: '', isError: false}));

		const {tools} = await client.listTools();

		expect(tools).toEqual([
			{name: 'read', description: 'Reads', inputSchema: {type: 'object', properties: {a: {type: 'number'}}}, annotations: {readOnlyHint: true}, _meta: {'anthropic/alwaysLoad': true}},
			{name: 'sleep_until', description: 'Sleeps', inputSchema: {type: 'object', properties: {seconds: {type: 'number'}}}, annotations: {readOnlyHint: false}, _meta: {'anthropic/alwaysLoad': true}},
		]);
	});

	test('runs a call through execute under the id the binary gives it, the arguments as JSON, and tells of the answer', async () => {
		const surface = fakeToolSurface(TOOLS, {text: 'rows', isError: false, endTurn: true});
		const told: Array<[string, {text: string; isError: boolean; endTurn?: boolean}]> = [];
		const client = await serve(surface.execute, (id, answer) => {
			told.push([id, answer]);
		});

		const called = await client.callTool({name: 'read', arguments: {a: 1}, _meta: {'claudecode/toolUseId': 'toolu_1'}});
		const unnamed = await client.callTool({name: 'read'});

		expect(called).toEqual({content: [{type: 'text', text: 'rows'}], isError: false});
		expect(surface.calls[0]).toEqual({id: 'toolu_1', name: 'read', arguments: '{"a":1}'});
		expect(surface.calls[1]).toMatchObject({name: 'read', arguments: '{}'});
		expect(surface.calls[1]?.id).toMatch(/^[0-9a-f-]{36}$/);
		expect(unnamed).toEqual({content: [{type: 'text', text: 'rows'}], isError: false});
		expect(told).toEqual([
			['toolu_1', {text: 'rows', isError: false, endTurn: true}],
			[surface.calls[1]?.id ?? '', {text: 'rows', isError: false, endTurn: true}],
		]);
	});

	test('answers a call execute failed on as an error, in words, and tells nothing of it', async () => {
		const told: string[] = [];
		const client = await serve(
			async () => Err(ApiErr.dbError(new Error('down'))),
			(id) => {
				told.push(id);
			},
		);

		const called = await client.callTool({name: 'read', arguments: {}});

		expect(called).toEqual({content: [{type: 'text', text: 'The call failed (db_error).'}], isError: true});
		expect(told).toEqual([]);
	});
});
