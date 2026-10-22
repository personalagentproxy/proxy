import {beforeEach, describe, expect, mock, test} from 'bun:test';
import {Ok} from 'ts-results-es';

import {findCollection, findIntegration} from '@proxy/integrations';

// The server's tools by name, answering as Cloudflare's do.
type Call = {name: string; args: Record<string, string>};
const tools = {calls: [] as Call[]};

mock.module('../connections/mcp/mcp-session', () => ({
	callMcpToolFor: async (_server: unknown, _connection: unknown, name: string, args: Record<string, string>) => {
		tools.calls.push({name, args});
		if (name === 'docs') {
			return Ok('<result>\n<url>https://developers.cloudflare.com/workers/</url>\n<title>Workers</title>\n<text>\nBuild serverless applications.\n</text>\n</result>');
		}
		if (name === 'search') {
			return Ok('GET /zones List Zones');
		}
		return Ok('{\n  "success": true,\n  "result": []\n}');
	},
}));

const {cloudflareConnector} = await import('./cloudflare-connector');
const {requestCode} = await import('../connections/cloudflare/cloudflare-mcp');

const cloudflare = findIntegration('cloudflare');

function run(command: string, values: Record<string, string>) {
	const collectionId = command === 'find' ? 'endpoints' : command === 'run' ? 'docs' : 'requests';
	const collection = cloudflare && findCollection(cloudflare, collectionId);
	const runner = cloudflareConnector.newCommands?.[command];
	if (!collection || !runner) {
		throw new Error(`No ${command}`);
	}
	const connection = {
		id: 'cf-1',
		integrationId: 'cloudflare',
		orgId: 'org-1',
		ownerUserId: 'user-1',
		connectedById: 'user-1',
		account: 'alex@example.com',
		createdAt: new Date(),
		tools: null,
		name: null,
		defaults: [],
		credential: 'v1.encrypted',
	};
	return runner({connection, collection}, values);
}

beforeEach(() => {
	tools.calls = [];
});

describe('requests', () => {
	test("reads with GET, the method left out, Cloudflare's answer as it is", async () => {
		const record = (await run('read', {path: '/zones?name=example.com'})).unwrap();

		expect(tools.calls).toEqual([{name: 'execute', args: {code: requestCode({method: 'GET', path: '/zones?name=example.com'})}}]);
		expect(record?.values).toEqual({method: 'GET', path: '/zones?name=example.com', response: '{\n  "success": true,\n  "result": []\n}'});
	});

	test('sends a body as JSON, in the account given', async () => {
		const body = '{"type": "A", "name": "www", "content": "192.0.2.1"}';
		const record = (await run('send', {method: 'patch', path: '/zones/z1/dns_records/r1', body, account: ' acc-1 '})).unwrap();

		expect(tools.calls).toEqual([
			{name: 'execute', args: {code: requestCode({method: 'PATCH', path: '/zones/z1/dns_records/r1', body: {type: 'A', name: 'www', content: '192.0.2.1'}}), account_id: 'acc-1'}},
		]);
		expect(record?.values).toMatchObject({method: 'PATCH', body, account: 'acc-1'});
	});

	test('sends POST and DELETE where the method is left out', async () => {
		await run('send', {path: '/accounts/{account_id}/d1/database', body: '{"name": "notes"}'});
		await run('remove', {path: '/zones/z1/dns_records/r1'});

		expect(tools.calls.map((call) => call.args.code)).toEqual([
			requestCode({method: 'POST', path: '/accounts/{account_id}/d1/database', body: {name: 'notes'}}),
			requestCode({method: 'DELETE', path: '/zones/z1/dns_records/r1'}),
		]);
	});

	test('each command sends only the methods of its own action', async () => {
		expect((await run('read', {method: 'POST', path: '/zones'})).unwrapErr()).toMatchObject({
			kind: 'validation_error',
			message: 'Read sends only GET requests and GraphQL queries to /graphql, not POST',
		});
		expect((await run('read', {method: 'DELETE', path: '/zones/z1'})).unwrapErr()).toMatchObject({kind: 'validation_error'});
		expect((await run('send', {method: 'DELETE', path: '/zones/z1'})).unwrapErr()).toMatchObject({kind: 'validation_error', message: 'Send sends only POST, PUT and PATCH requests, not DELETE'});
		expect((await run('send', {method: 'GET', path: '/zones'})).unwrapErr()).toMatchObject({kind: 'validation_error'});
		expect((await run('remove', {method: 'PUT', path: '/zones/z1'})).unwrapErr()).toMatchObject({kind: 'validation_error'});
		expect(tools.calls).toEqual([]);
	});

	test('reads a GraphQL analytics query as a POST to /graphql, never a mutation', async () => {
		const body = '{"query": "{ viewer { zones(filter: {zoneTag: \\"z1\\"}) { httpRequests1dGroups(limit: 7) { sum { requests } } } } }"}';
		await run('read', {path: '/graphql', body});
		expect(tools.calls[0]?.args.code).toBe(requestCode({method: 'POST', path: '/graphql', body: JSON.parse(body)}));

		expect((await run('read', {path: '/graphql', body: '{"query": "mutation { deleteEverything }"}'})).unwrapErr().kind).toBe('validation_error');
		// A mutation after a comment, after a query `operationName` passes over, or after a fragment.
		for (const query of [
			'# hi\nmutation { deleteEverything }',
			'query A { viewer { zones { zoneTag } } } mutation B { deleteEverything }',
			'fragment F on Zone { zoneTag } mutation { deleteEverything }',
			'subscription { changes }',
		]) {
			expect((await run('read', {path: '/graphql', body: JSON.stringify({query, operationName: 'B'})})).unwrapErr().kind).toBe('validation_error');
		}
		expect((await run('read', {path: '/graphql'})).unwrapErr().kind).toBe('validation_error');
		expect(tools.calls).toHaveLength(1);
	});

	test('reads a query that only says "mutation" in a string or a comment', async () => {
		const query = '# no mutation here\n{ viewer { zones(filter: {zoneTag: "mutation"}) { zoneTag } } }';
		await run('read', {path: '/graphql', body: JSON.stringify({query})});
		expect(tools.calls).toHaveLength(1);
	});

	test('refuses a GET with a body, before asking Cloudflare', async () => {
		expect((await run('read', {path: '/zones', body: '{}'})).unwrapErr()).toMatchObject({kind: 'validation_error', message: expect.stringContaining('A GET request has no body')});
		expect(tools.calls).toEqual([]);
	});

	test('refuses a body that is no JSON and a path that is no path, before asking Cloudflare', async () => {
		expect((await run('send', {path: '/zones', body: '{name: example.com}'})).unwrapErr().kind).toBe('validation_error');
		expect((await run('read', {path: 'zones'})).unwrapErr().kind).toBe('validation_error');
		expect(tools.calls).toEqual([]);
	});
});

describe('the API reference and the docs', () => {
	test("looks up endpoints with Cloudflare's search, the search written into its code", async () => {
		const record = (await run('find', {search: ' dns records '})).unwrap();

		expect(tools.calls[0]?.name).toBe('search');
		expect(tools.calls[0]?.args.code).toContain('"dns records", spec, 50');
		expect(record?.values).toEqual({search: 'dns records', endpoints: 'GET /zones List Zones'});
	});

	test("searches Cloudflare's docs", async () => {
		const record = (await run('run', {query: 'durable objects alarms'})).unwrap();

		expect(tools.calls).toEqual([{name: 'docs', args: {query: 'durable objects alarms'}}]);
		expect(record?.values.results).toContain('Build serverless applications.');
	});

	test('refuses an empty search', async () => {
		expect((await run('find', {search: ' '})).unwrapErr().kind).toBe('validation_error');
		expect((await run('run', {query: ''})).unwrapErr().kind).toBe('validation_error');
	});
});
