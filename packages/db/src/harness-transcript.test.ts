import {afterAll, describe, expect, test} from 'bun:test';
import type {Result} from 'ts-results-es';

import type {ApiError} from '@proxy/utils';

import {db} from '.';
import {
	appendTranscript,
	deleteTranscript,
	listTranscriptSubkeys,
	loadTranscript,
} from './harness-transcript';

// The SDK's transcripts, against the local database, as harness.test.ts runs: skipped without
// DATABASE_URL. Everything made here is under one project key, deleted at the end.
const databaseUrl = process.env.DATABASE_URL;

function unwrap<T>(result: Result<T, ApiError>): T {
	if (result.isErr()) {
		throw new Error(JSON.stringify(result.error));
	}
	return result.value;
}

describe.skipIf(!databaseUrl)('the harness transcripts, against the database', () => {
	const projectKey = `transcript-test-${Date.now()}-${process.pid}`;
	const main = {projectKey, sessionId: 'session-1'};
	const side = {...main, subpath: 'subagents/agent-1.jsonl'};
	const other = {projectKey, sessionId: 'session-2'};

	afterAll(async () => {
		await db.agentHarnessTranscript.deleteMany({where: {projectKey}});
		await db.$disconnect();
	});

	test('lines are appended in order and read back so, a line with a uuid once however often it comes; none is null', async () => {
		expect(unwrap(await loadTranscript(main))).toBeNull();
		unwrap(await appendTranscript(main, []));
		expect(unwrap(await loadTranscript(main))).toBeNull();

		unwrap(
			await appendTranscript(main, [
				{uuid: 'u1', entry: '{"type":"user","uuid":"u1"}'},
				{entry: '{"type":"summary"}'},
				{uuid: 'a1', entry: '{"type":"assistant","uuid":"a1"}'},
				{uuid: 'a1', entry: '{"type":"assistant","uuid":"a1","again":true}'},
			]),
		);
		// The batch delivered again, with one more line.
		unwrap(
			await appendTranscript(main, [
				{uuid: 'u1', entry: '{"type":"user","uuid":"u1"}'},
				{uuid: 'a1', entry: '{"type":"assistant","uuid":"a1"}'},
				{entry: '{"type":"summary"}'},
				{uuid: 'u2', entry: '{"type":"user","uuid":"u2"}'},
			]),
		);
		expect(unwrap(await loadTranscript(main))).toEqual([
			'{"type":"user","uuid":"u1"}',
			'{"type":"summary"}',
			'{"type":"assistant","uuid":"a1"}',
			'{"type":"summary"}',
			'{"type":"user","uuid":"u2"}',
		]);
	});

	test('a subpath is a transcript of its own, listed with the session’s others, and a uuid counts per transcript', async () => {
		unwrap(
			await appendTranscript(side, [{uuid: 'u1', entry: '{"type":"user","uuid":"u1","sub":true}'}]),
		);
		unwrap(
			await appendTranscript({...main, subpath: 'tool-results/t1.json'}, [{entry: '{"big":true}'}]),
		);
		unwrap(
			await appendTranscript(other, [
				{uuid: 'u1', entry: '{"type":"user","uuid":"u1","other":true}'},
			]),
		);

		expect(unwrap(await loadTranscript(side))).toEqual(['{"type":"user","uuid":"u1","sub":true}']);
		expect(unwrap(await loadTranscript(main))).toHaveLength(5);
		expect(unwrap(await listTranscriptSubkeys(main))).toEqual([
			'subagents/agent-1.jsonl',
			'tool-results/t1.json',
		]);
		expect(unwrap(await listTranscriptSubkeys(other))).toEqual([]);
	});

	test('deleting a subpath deletes that transcript alone; deleting the session deletes every one of its', async () => {
		unwrap(await deleteTranscript({...main, subpath: 'tool-results/t1.json'}));
		expect(unwrap(await listTranscriptSubkeys(main))).toEqual(['subagents/agent-1.jsonl']);
		expect(unwrap(await loadTranscript(main))).toHaveLength(5);

		unwrap(await deleteTranscript(main));
		expect(unwrap(await loadTranscript(main))).toBeNull();
		expect(unwrap(await loadTranscript(side))).toBeNull();
		expect(unwrap(await listTranscriptSubkeys(main))).toEqual([]);
		expect(unwrap(await loadTranscript(other))).toHaveLength(1);
	});
});
