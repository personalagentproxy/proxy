import {beforeEach, describe, expect, mock, spyOn, test} from 'bun:test';
import {Ok, type Result} from 'ts-results-es';

import type {ApiError} from '@proxy/utils';
import type {JsonValue} from '@proxy/utils/harness';

const markCredentialRejected = mock(async () => Ok(true));
mock.module('@proxy/db/connection', () => ({markCredentialRejected, updateConnectionCredential: mock(), getConnectionCredential: mock(async () => Ok(null))}));

// The history every replacement goes through (google-history.ts), kept in memory: each task has
// its copy already, and the changes logged are kept to look at.
type Logged = {kind: string; fileId: string; name: string; beforeRevision?: string | null; afterRevision?: string | null};
const history = {logged: [] as Logged[]};
mock.module('@proxy/db/files', () => ({
	hasTaskCopied: mock(async () => Ok(true)),
	getLatestFileVersion: mock(async () => Ok(null)),
	recordFileVersion: mock(),
	logFileChange: mock(async (_change: object, entry: Logged) => {
		history.logged.push(entry);
		return Ok({change: {id: `change-${history.logged.length}`, ...entry}, version: null});
	}),
	createFileBlob: mock(),
	completeFileBlob: mock(),
}));

mock.module('../observability/log', () => ({
	log: {debug: mock(), info: mock(), warn: mock(), error: mock()},
	serializeError: mock(() => ({})),
}));

mock.module('../utils/env', () => ({env: {NODE_ENV: 'production', APP_URL: 'https://app.example.com', GOOGLE_CLIENT_ID: 'client-1', GOOGLE_CLIENT_SECRET: 'secret-1'}}));

mock.module('../utils/secret-crypto', () => ({
	encryptSecret: (plaintext: string): Result<string, ApiError> => Ok(`enc:${plaintext}`),
	decryptSecret: (stored: string): Result<string, ApiError> => Ok(stored.replace(/^enc:/, '')),
}));

function refusal<T>(result: Result<T, ApiError>): string {
	if (result.isOk()) {
		throw new Error('expected a refusal');
	}
	return 'message' in result.error && result.error.message ? `${result.error.kind}: ${result.error.message}` : result.error.kind;
}

const CREDENTIAL = {accessToken: 'access-1', refreshToken: 'refresh-1', expiresAt: new Date(Date.now() + 3_600_000).toISOString(), scopes: [], email: 'alex@example.com'};

const connection = {
	id: 'google-1',
	integrationId: 'google',
	orgId: 'org-1',
	ownerUserId: 'user-1',
	sharedWithEveryone: false,
	shares: [],
	account: 'alex@example.com',
	createdAt: new Date(),
	tools: null,
	name: null,
	defaults: [],
	credentialRejectedAt: null,
	credential: `enc:${JSON.stringify(CREDENTIAL)}`,
};

const agent = {agentId: 'agent-1', orgId: 'org-1', ownerUserId: 'user-1', providerId: 'claude', name: 'Claude', orgSlug: 'acme', experiments: []};

function run(params: Record<string, unknown>) {
	return {caller: {agent, via: 'mcp' as const, taskId: 'task-1'}, connection, params};
}

function text(...runs: string[]) {
	return {textElements: [{paragraphMarker: {}}, ...runs.map((content) => ({textRun: {content, style: {}}}))]};
}

// A deck of two slides: a title and a box split into two runs, a table and a group with a shape in
// it, and a picture, which has no text.
const SLIDES = [
	{
		objectId: 's1',
		pageElements: [
			{objectId: 'title', shape: {shapeType: 'TEXT_BOX', text: text('Q3 review\n')}},
			{objectId: 'body', shape: {text: text('Revenue grew ', '12%\n', 'Costs held\n')}},
		],
	},
	{
		objectId: 's2',
		pageElements: [
			{objectId: 'table', table: {tableRows: [{tableCells: [{text: text('Region\n')}, {text: text('EMEA\n')}]}]}},
			{objectId: 'group', elementGroup: {children: [{objectId: 'note', shape: {text: text('Next: Q4 plan\n')}}]}},
			{objectId: 'picture', image: {contentUrl: 'https://example.com/chart.png'}},
		],
	},
	{objectId: 's3', pageElements: [{objectId: 'picture2', image: {}}]},
];

// The fake Slides and Drive: the presentation at its revision, the batches it took, and what the
// history asks of Drive.
const slides = {revision: 'rev-1', batches: [] as {requests: JsonValue[]; writeControl: {requiredRevisionId: string}}[]};
const google = {requests: [] as {method: string; url: URL}[]};

spyOn(globalThis, 'fetch').mockImplementation((async (input: string | URL | Request, init?: RequestInit) => {
	const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
	const method = init?.method ?? 'GET';
	google.requests.push({method, url});
	const path = decodeURIComponent(url.pathname);
	if (path === '/drive/v3/files/1Deck') {
		return Response.json({id: '1Deck', name: 'Q3 review', mimeType: 'application/vnd.google-apps.presentation'});
	}
	if (path === '/drive/v3/files/1Deck/revisions') {
		return Response.json({revisions: [{id: `d${slides.batches.length + 1}`}]});
	}
	if (path === '/v1/presentations/1Deck' && method === 'GET') {
		return Response.json({presentationId: '1Deck', title: 'Q3 review', revisionId: slides.revision, slides: SLIDES});
	}
	if (path === '/v1/presentations/1Deck:batchUpdate') {
		const batch = JSON.parse(typeof init?.body === 'string' ? init.body : '{}');
		if (batch.writeControl?.requiredRevisionId !== slides.revision) {
			// As Google answers it.
			return Response.json({error: {code: 400, message: "The required revision ID 'rev-1' does not match the latest revision.", status: 'INVALID_ARGUMENT'}}, {status: 400});
		}
		slides.batches.push(batch);
		slides.revision = `rev-${slides.batches.length + 1}`;
		// How many times each text is on the slides it names, as Slides counts them; it leaves out how many were changed where none were.
		const replies = batch.requests.map(({replaceAllText}: {replaceAllText: {containsText: {text: string}; pageObjectIds: string[]}}) => {
			const on = SLIDES.filter((slide) => replaceAllText.pageObjectIds.includes(slide.objectId));
			const times = JSON.stringify(on).split(replaceAllText.containsText.text).length - 1;
			return {replaceAllText: times === 0 ? {} : {occurrencesChanged: times}};
		});
		return Response.json({presentationId: '1Deck', replies, writeControl: {requiredRevisionId: slides.revision}});
	}
	return Response.json({error: {code: 404, message: 'Requested entity was not found.', status: 'NOT_FOUND'}}, {status: 404});
}) as typeof fetch);

beforeEach(() => {
	slides.revision = 'rev-1';
	slides.batches = [];
	google.requests = [];
	history.logged = [];
});

describe('reading a presentation', () => {
	test('answers each slide’s text, its shapes’, tables’ and groups’, with the revision it is at', async () => {
		const {runSlidesRead} = await import('./google-slides');
		const answer = (await runSlidesRead(run({id: 'https://docs.google.com/presentation/d/1Deck/edit#slide=id.p'}))).unwrap();

		expect(answer).toBe(
			[
				'“Q3 review”, at revision rev-1, which slides_edit takes as revision.',
				'Link: https://docs.google.com/presentation/d/1Deck/edit',
				'',
				'Slide 1:',
				'Q3 review',
				'Revenue grew 12%\nCosts held',
				'',
				'Slide 2:',
				'Region',
				'EMEA',
				'Next: Q4 plan',
				'',
				'Slide 3:',
				'(no text)',
			].join('\n'),
		);
		expect(google.requests[0]?.url.searchParams.get('fields')).toBe('title,revisionId,slides(objectId,pageElements)');
	});
});

describe('replacing text in a presentation', () => {
	test('replaces text found once, matched with its case, only on the slide it is on, at the revision read, and says how often', async () => {
		const {runSlidesEdit} = await import('./google-slides');
		const answer = (
			await runSlidesEdit(
				run({
					id: '1Deck',
					revision: 'rev-1',
					replace: [
						{find: '12%', replace: '15%'},
						{find: 'EMEA', replace: 'Europe'},
					],
				}),
			)
		).unwrap();

		expect(slides.batches).toEqual([
			{
				requests: [
					{replaceAllText: {containsText: {text: '12%', matchCase: true}, replaceText: '15%', pageObjectIds: ['s1']}},
					{replaceAllText: {containsText: {text: 'EMEA', matchCase: true}, replaceText: 'Europe', pageObjectIds: ['s2']}},
				],
				writeControl: {requiredRevisionId: 'rev-1'},
			},
		]);
		expect(answer).toBe(
			['“12%”: replaced once', '“EMEA”: replaced once', 'It is at revision rev-2 now, which slides_edit takes for more.', 'Link: https://docs.google.com/presentation/d/1Deck/edit'].join('\n'),
		);
		expect(history.logged).toEqual([expect.objectContaining({kind: 'edit', fileId: '1Deck', name: 'Q3 review', beforeRevision: 'd1', afterRevision: 'd2'})]);
	});

	test('text on more than one slide is replaced only on the slide named, or every time with all', async () => {
		const {runSlidesEdit} = await import('./google-slides');
		expect(refusal(await runSlidesEdit(run({id: '1Deck', revision: 'rev-1', replace: [{find: 'Re', replace: 'Ra'}]})))).toBe(
			'validation_error: Nothing was replaced:\nReplacement 1: “Re” appears 2 times in the presentation, on slides 1 and 2. Make find longer, with the words around it, so it appears once, name its slide with slide, or give all to replace every one.',
		);

		(await runSlidesEdit(run({id: '1Deck', revision: 'rev-1', replace: [{find: 'Re', replace: 'Ra', slide: 2}]}))).unwrap();
		const answer = (await runSlidesEdit(run({id: '1Deck', revision: 'rev-2', replace: [{find: 'Re', replace: 'Ra', all: true}]}))).unwrap();

		expect(slides.batches.map((batch) => batch.requests)).toEqual([
			[{replaceAllText: {containsText: {text: 'Re', matchCase: true}, replaceText: 'Ra', pageObjectIds: ['s2']}}],
			[{replaceAllText: {containsText: {text: 'Re', matchCase: true}, replaceText: 'Ra', pageObjectIds: ['s1', 's2']}}],
		]);
		expect(answer.split('\n')[0]).toBe('“Re”: replaced 2 times');
	});

	test('text that appears nowhere, a slide the presentation hasn’t, or a find another replacement writes is turned down, every one at once, and nothing is sent', async () => {
		const {runSlidesEdit} = await import('./google-slides');
		const result = await runSlidesEdit(
			run({
				id: '1Deck',
				revision: 'rev-1',
				replace: [
					{find: 'Q5', replace: 'Q6'},
					{find: 'EMEA', replace: 'Europe', slide: 1},
					{find: 'Q3', replace: 'Q4', slide: 9},
					{find: 'Costs', replace: 'Spend held'},
					{find: 'held', replace: 'stayed'},
				],
			}),
		);

		expect(refusal(result)).toBe(
			[
				'validation_error: Nothing was replaced:',
				'Replacement 1: “Q5” appears nowhere in the presentation. find matches the text as slides_read answers it, exactly, its case too, within one shape or cell.',
				'Replacement 2: “EMEA” appears nowhere on slide 1. find matches the text as slides_read answers it, exactly, its case too, within one shape or cell.',
				'Replacement 3: the presentation has 3 slides, so there is no slide 9',
				'Replacement 5 finds text that Replacement 4 writes: make them one, or replace in two calls',
			].join('\n'),
		);
		expect(slides.batches).toEqual([]);
	});

	test('replacements that can’t be placed in a presentation changed since the revision read are turned down as stale', async () => {
		slides.revision = 'rev-4';
		const {runSlidesEdit} = await import('./google-slides');
		const result = await runSlidesEdit(run({id: '1Deck', revision: 'rev-1', replace: [{find: 'Q5', replace: 'Q6'}]}));

		expect(refusal(result)).toStartWith('conflict: The presentation changed since revision rev-1 was read');
		expect(slides.batches).toEqual([]);
	});

	test('a replacement on an older revision than the presentation’s is turned down by Slides, and nothing is logged', async () => {
		slides.revision = 'rev-4';
		const {runSlidesEdit} = await import('./google-slides');
		const result = await runSlidesEdit(run({id: '1Deck', revision: 'rev-1', replace: [{find: 'Q3', replace: 'Q4'}]}));

		expect(refusal(result)).toBe(
			'conflict: The presentation changed since revision rev-1 was read, or that revision is too old: nothing was replaced. Read it again with slides_read, and replace text on what it holds now, with its new revision.',
		);
		expect(history.logged).toEqual([]);
	});

	test('no replacements, or one without a find, never reach Google', async () => {
		const {runSlidesEdit} = await import('./google-slides');
		const refusals = [await runSlidesEdit(run({id: '1Deck', revision: 'rev-1', replace: []})), await runSlidesEdit(run({id: '1Deck', revision: 'rev-1', replace: [{find: '', replace: 'x'}]}))];

		expect(refusals.map((result) => refusal(result).split(':\n')[0])).toEqual([
			'validation_error: slides_edit takes id, revision and replace, each a find and its replace, and slide and all where wanted',
			'validation_error: slides_edit takes id, revision and replace, each a find and its replace, and slide and all where wanted',
		]);
		expect(google.requests).toEqual([]);
	});
});
