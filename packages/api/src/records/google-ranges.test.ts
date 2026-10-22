import {beforeEach, describe, expect, mock, spyOn, test} from 'bun:test';
import {Ok, type Result} from 'ts-results-es';

import type {ApiError} from '@proxy/utils';
import {findCollection, findIntegration, type Collection} from '@proxy/integrations';

mock.module('@proxy/db/connection', () => ({updateConnectionCredential: mock(), getConnectionCredential: mock(async () => Ok(null))}));

mock.module('../observability/log', () => ({
	log: {debug: mock(), info: mock(), warn: mock(), error: mock()},
	serializeError: mock(() => ({})),
}));

mock.module('../utils/env', () => ({env: {NODE_ENV: 'production', APP_URL: 'https://app.example.com', GOOGLE_CLIENT_ID: 'client-1', GOOGLE_CLIENT_SECRET: 'secret-1'}}));

mock.module('../utils/secret-crypto', () => ({
	encryptSecret: (plaintext: string): Result<string, ApiError> => Ok(`enc:${plaintext}`),
	decryptSecret: (stored: string): Result<string, ApiError> => Ok(stored.replace(/^enc:/, '')),
}));

function ranges(): Collection {
	const integration = findIntegration('google');
	const found = integration && findCollection(integration, 'ranges');
	if (!found) {
		throw new Error('No ranges collection');
	}
	return found;
}

// What a refusal says, or its kind where it says nothing of its own.
function messageOf<T>(result: Result<T, ApiError> | undefined): string | null {
	if (!result || result.isOk()) {
		return null;
	}
	return 'message' in result.error ? result.error.message : result.error.kind;
}

const CREDENTIAL = {accessToken: 'access-1', refreshToken: 'refresh-1', expiresAt: new Date(Date.now() + 3_600_000).toISOString(), scopes: [], email: 'alex@example.com'};

const target = {
	connection: {
		id: 'google-1',
		integrationId: 'google',
		orgId: 'org-1',
		ownerUserId: 'user-1',
		connectedById: 'user-1',
		account: 'alex@example.com',
		createdAt: new Date(),
		tools: null,
		name: null,
		defaults: [],
		credential: `enc:${JSON.stringify(CREDENTIAL)}`,
	},
	collection: ranges(),
};

type Request = {method: string; url: URL; body: string};

const google = {requests: [] as Request[], answer: (_request: Request): Response | null => null};

spyOn(globalThis, 'fetch').mockImplementation((async (input: string | URL | Request, init?: RequestInit) => {
	const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
	const request = {method: init?.method ?? 'GET', url, body: typeof init?.body === 'string' ? init.body : ''};
	google.requests.push(request);
	const custom = google.answer(request);
	if (custom) {
		return custom;
	}
	if (request.method === 'PUT') {
		const {range, values} = JSON.parse(request.body);
		return Response.json({
			updatedRange: "'Q1 Sales'!A2:C3",
			updatedRows: values.length,
			updatedData: {
				range,
				values: [
					['Rent', '1,200', '2,400'],
					['Food, drink', '300', '600'],
				],
			},
		});
	}
	return Response.json({
		range: "'Q1 Sales'!A1:C3",
		majorDimension: 'ROWS',
		values: [
			['Item', 'Amount'],
			['Rent', 1200],
			['Say "hi"', ''],
		],
	});
}) as typeof fetch);

beforeEach(() => {
	google.requests = [];
	google.answer = () => null;
});

const LINK = 'https://docs.google.com/spreadsheets/d/1BudgetSheet_x-9/edit?gid=0#gid=0';

describe('reading a range', () => {
	test('a range of a spreadsheet given by its link answers its values as CSV', async () => {
		const {googleConnector} = await import('./google-connector');
		const record = (await googleConnector.newCommands?.read?.(target, {spreadsheet: LINK, range: "'Q1 Sales'!A1:C3", values: ''}))?.unwrap();

		const [request] = google.requests;
		expect(request?.url.pathname).toBe("/v4/spreadsheets/1BudgetSheet_x-9/values/'Q1%20Sales'!A1%3AC3");
		expect(record?.values).toEqual({spreadsheet: '1BudgetSheet_x-9', range: "'Q1 Sales'!A1:C3", rows: '3 rows', result: 'Item,Amount\nRent,1200\n"Say ""hi""",'});
	});

	test('a range of more than 1000 rows answers the first 1000, saying how many there are', async () => {
		google.answer = () => Response.json({range: "'Q1 Sales'!A1:A1500", majorDimension: 'ROWS', values: Array.from({length: 1500}, (_, index) => [String(index + 1)])});
		const {googleConnector} = await import('./google-connector');
		const record = (await googleConnector.newCommands?.read?.(target, {spreadsheet: LINK, range: "'Q1 Sales'!A:A", values: ''}))?.unwrap();

		expect(record?.values.rows).toBe('The first 1000 of 1500 rows: read the rest as a range starting below them');
		expect(record?.values.result?.split('\n')).toHaveLength(1000);
	});

	test('a spreadsheet is taken by its id or a Drive link, and a range without a tab or in an unquoted one', async () => {
		const {googleConnector} = await import('./google-connector');
		await googleConnector.newCommands?.read?.(target, {spreadsheet: '1BudgetSheet', range: 'Sheet1!B:B'});
		await googleConnector.newCommands?.read?.(target, {spreadsheet: 'https://drive.google.com/open?id=1BudgetSheet', range: 'A1:C9'});
		await googleConnector.newCommands?.read?.(target, {spreadsheet: '1BudgetSheet', range: '$A$1:$F$20'});
		await googleConnector.newCommands?.read?.(target, {spreadsheet: '1BudgetSheet', range: 'Übersicht!A1'});

		expect(google.requests.map((request) => decodeURIComponent(request.url.pathname))).toEqual([
			'/v4/spreadsheets/1BudgetSheet/values/Sheet1!B:B',
			'/v4/spreadsheets/1BudgetSheet/values/A1:C9',
			'/v4/spreadsheets/1BudgetSheet/values/$A$1:$F$20',
			'/v4/spreadsheets/1BudgetSheet/values/Übersicht!A1',
		]);
	});

	test('a range that isn’t A1 notation, or a spreadsheet that isn’t Google’s, never reaches Google', async () => {
		const {googleConnector} = await import('./google-connector');
		const refusals = await Promise.all([
			googleConnector.newCommands?.read?.(target, {spreadsheet: '1BudgetSheet', range: 'A1:C3?fields=*'}),
			googleConnector.newCommands?.read?.(target, {spreadsheet: '1BudgetSheet', range: "'Q1'!A1/../../x"}),
			googleConnector.newCommands?.read?.(target, {spreadsheet: '1BudgetSheet', range: ''}),
			googleConnector.newCommands?.read?.(target, {spreadsheet: 'https://evil.example.com/d/1BudgetSheet', range: 'A1'}),
			googleConnector.newCommands?.read?.(target, {spreadsheet: '../1BudgetSheet', range: 'A1'}),
		]);

		expect(refusals.map((result) => result?.isErr() && result.error.kind)).toEqual(['validation_error', 'validation_error', 'validation_error', 'validation_error', 'validation_error']);
		expect(google.requests).toEqual([]);
	});

	test('Google turning a range down is passed on in its own words', async () => {
		const {googleConnector} = await import('./google-connector');
		google.answer = () => Response.json({error: {code: 400, message: "Unable to parse range: 'Nope'!A1", status: 'INVALID_ARGUMENT'}}, {status: 400});
		const result = await googleConnector.newCommands?.read?.(target, {spreadsheet: '1BudgetSheet', range: "'Nope'!A1"});

		expect(result?.isErr() && result.error).toEqual({kind: 'validation_error', statusCode: 400, message: "Google: Unable to parse range: 'Nope'!A1"});
	});
});

describe('writing a range', () => {
	test('CSV is written as if typed in, and the answer is what the range holds now', async () => {
		const {googleConnector} = await import('./google-connector');
		const record = (await googleConnector.newCommands?.write?.(target, {spreadsheet: LINK, range: "'Q1 Sales'!A2", values: 'Rent,"1,200",=B2*2\n"Food, drink",300,=B3*2\n'}))?.unwrap();

		const [request] = google.requests;
		expect(request?.method).toBe('PUT');
		expect(Object.fromEntries(request?.url.searchParams ?? [])).toEqual({valueInputOption: 'USER_ENTERED', includeValuesInResponse: 'true', responseValueRenderOption: 'FORMATTED_VALUE'});
		expect(JSON.parse(request?.body ?? '')).toEqual({
			range: "'Q1 Sales'!A2",
			majorDimension: 'ROWS',
			values: [
				['Rent', '1,200', '=B2*2'],
				['Food, drink', '300', '=B3*2'],
			],
		});
		expect(record?.values).toEqual({spreadsheet: '1BudgetSheet_x-9', range: "'Q1 Sales'!A2:C3", rows: '2 rows', result: 'Rent,"1,200","2,400"\n"Food, drink",300,600'});
	});

	test('an empty value in quotes empties the cell', async () => {
		const {googleConnector} = await import('./google-connector');
		await googleConnector.newCommands?.write?.(target, {spreadsheet: LINK, range: 'A1', values: '""'});

		expect(JSON.parse(google.requests[0]?.body ?? '').values).toEqual([['']]);
	});

	test('no values, or a quote never closed, is turned down', async () => {
		const {googleConnector} = await import('./google-connector');
		const empty = await googleConnector.newCommands?.write?.(target, {spreadsheet: LINK, range: 'A1', values: ''});
		const unclosed = await googleConnector.newCommands?.write?.(target, {spreadsheet: LINK, range: 'A1', values: '"Rent,1200'});

		expect(messageOf(empty)).toBe('Write the values as CSV, one row a line; "" empties a cell');
		expect(messageOf(unclosed)).toBe('The CSV has a quote that is never closed');
		expect(google.requests).toEqual([]);
	});

	test('ranges are never listed or opened', async () => {
		const {googleConnector} = await import('./google-connector');
		const result = await googleConnector.get(target, 'range');

		expect(result.isErr() && result.error.kind).toBe('validation_error');
	});
});
