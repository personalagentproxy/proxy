// `bun --env-file=../../.env scripts/claude-harness-smoke.ts`, from packages/api: runs the Claude
// Agent SDK harness for real, the binary and the model included, which the tests never do. It
// needs a credential in its environment, CLAUDE_CODE_OAUTH_TOKEN (a Claude sign-in's token, as
// `claude setup-token` prints one) or ANTHROPIC_API_KEY, and stops with a message without one.
// The harness is built as the api builds it, but on a session store in memory and a tool surface
// of one tool, `echo`, which answers with what it is given. Two turns are run on one thread: the
// first asks the model to call the tool and say what it answered, the second resumes the session
// the first left and asks what was called before, so the resume is seen to work. Each event is
// printed as it comes; the credential never is. The run spends a little of the credential's quota.
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {Ok} from 'ts-results-es';

import type {HarnessAuth, HarnessEntry, HarnessEvent, HarnessSession, ToolSurface} from '@proxy/backends/harness/backend';
import {claudeAgentSdkHarness} from '@proxy/backends/harness/claude-agent-sdk';
import {memorySessionStore} from '@proxy/backends/harness/session-store';
import {isRecord} from '@proxy/utils/harness';
import type {ContextEntry} from '@proxy/utils/harness-context';

const SYSTEM = 'You are a test agent with one tool, echo. Answer in one short sentence.';
const FIRST = "Call the echo tool with 'hi' and tell me what it answered";
const SECOND = 'What did you call before?';
// The job of the first turn, which the session keeps, and the log has the turn's answer under.
const FIRST_JOB = 'smoke-job-1';

// The credential as the harness takes it: a token as a sign-in's, with no scopes, or a key.
function authFromEnv(): HarnessAuth | null {
	const token = process.env.CLAUDE_CODE_OAUTH_TOKEN;
	if (token) {
		return {kind: 'oauth', accessToken: token, scopes: []};
	}
	const key = process.env.ANTHROPIC_API_KEY;
	if (key) {
		return {kind: 'api_key', key};
	}
	return null;
}

const tools: ToolSurface = {
	tools: [{name: 'echo', description: 'Answers with the text it is given.', inputSchema: {type: 'object', properties: {text: {type: 'string'}}, required: ['text']}, readOnly: true}],
	execute: async (call) => {
		const args: unknown = JSON.parse(call.arguments);
		const text = isRecord(args) && typeof args.text === 'string' ? args.text : '';
		console.log(`  execute ${call.id} ${call.name} ${call.arguments}`);
		return Ok({text: `echo: ${text}`, isError: false});
	},
};

// An event in a line, nothing of the environment in it.
function line(event: HarnessEvent): string {
	if (event.kind === 'text') {
		return `text: ${event.text}`;
	}
	if (event.kind === 'tool_call') {
		return `tool_call ${event.id}: ${event.name} ${event.arguments}`;
	}
	if (event.kind === 'tool_result') {
		return `tool_result ${event.callId}${event.isError ? ' (error)' : ''}: ${event.text}`;
	}
	if (event.kind === 'summary') {
		return `summary up to ${event.coversSeq}: ${event.text}`;
	}
	if (event.kind === 'done') {
		return `done: session ${event.session?.id ?? 'none'} ${JSON.stringify(event.session?.state ?? null)}, ${event.inputTokens} in, ${event.outputTokens} out`;
	}
	if (event.kind === 'usage') {
		const window = (name: string, used: {utilization: number; resetsAt: Date | null} | undefined) =>
			used ? `${name} ${Math.round(used.utilization * 100)}% used, resets ${used.resetsAt?.toISOString() ?? 'unknown'}` : null;
		return `usage: ${[window('5h', event.fiveHour), window('7d', event.sevenDay)].filter((part) => part !== null).join('; ')}`;
	}
	const cause = 'cause' in event.error && event.error.cause instanceof Error ? `: ${event.error.cause.message}` : '';
	return `failed (${event.error.kind}${cause}), retry ${event.retry}`;
}

// An entry of the log, written by `jobId`, the turn's job, where the model said it.
function entry(seq: number, kind: ContextEntry['kind'], text: string, jobId: string | null = null): HarnessEntry {
	return {kind, text, toolCalls: null, callId: null, isError: false, seq, coversSeq: null, inputTokens: null, jobId};
}

async function main(): Promise<void> {
	const auth = authFromEnv();
	if (auth === null) {
		console.error('Set CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY in the environment to run the smoke test.');
		process.exit(1);
	}
	const dir = join(tmpdir(), 'proxy-harness-smoke');
	const harness = claudeAgentSdkHarness({sessionStore: memorySessionStore(), workDir: join(dir, 'work'), configDir: join(dir, 'config'), maxConcurrentTurns: 1});
	const thread = {id: `smoke-${Date.now()}`};
	let session: HarnessSession = null;
	let said = '';

	console.log(`Turn 1 on ${thread.id} (${auth.kind}): ${FIRST}`);
	for await (const event of harness.turn({
		thread,
		job: FIRST_JOB,
		auth,
		session,
		entries: [entry(1, 'person', FIRST)],
		woken: false,
		system: SYSTEM,
		tools,
		model: 'claude',
		signal: new AbortController().signal,
	})) {
		console.log(`  ${line(event)}`);
		if (event.kind === 'text') {
			said = `${said}${said === '' ? '' : '\n\n'}${event.text}`;
		}
		if (event.kind === 'done') {
			session = event.session;
		}
	}
	if (session === null) {
		console.error('The first turn kept no session, so there is nothing to resume.');
		process.exit(1);
	}

	console.log(`Turn 2, resuming ${session.id}: ${SECOND}`);
	const entries = [entry(1, 'person', FIRST), entry(2, 'assistant', said, FIRST_JOB), entry(3, 'person', SECOND)];
	for await (const event of harness.turn({
		thread,
		job: 'smoke-job-2',
		auth,
		session,
		entries,
		woken: false,
		system: SYSTEM,
		tools,
		model: 'claude',
		signal: new AbortController().signal,
	})) {
		console.log(`  ${line(event)}`);
	}
}

void main();
