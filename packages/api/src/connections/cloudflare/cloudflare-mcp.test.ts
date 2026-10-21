import {describe, expect, test} from 'bun:test';

import {CLOUDFLARE, endpointsCode, findEndpoints, isGraphqlPath, requestCode, requestPath, type ApiSpec, type CloudflareRequest} from './cloudflare-mcp';

// Runs the code sent to `execute` as Cloudflare's sandbox would, with its `cloudflare` and `accountId`.
async function execute(code: string, accountId: string | undefined) {
	const sent: CloudflareRequest[] = [];
	const cloudflare = {request: async (request: CloudflareRequest) => (sent.push(request), {success: true, result: []})};
	const run = new Function('cloudflare', 'accountId', `return (${code})();`);
	return {answer: await run(cloudflare, accountId), sent};
}

const SPEC: ApiSpec = {
	paths: {
		'/zones': {get: {summary: 'List Zones', tags: ['Zone']}},
		'/zones/{zone_id}/dns_records': {
			get: {summary: 'List DNS Records', tags: ['DNS Records for a Zone']},
			post: {
				summary: 'Create DNS Record',
				tags: ['DNS Records for a Zone'],
				parameters: [{name: 'zone_id', in: 'path'}],
				requestBody: {content: {'application/json': {schema: {type: 'object', required: ['type', 'name']}}}},
			},
		},
		'/accounts/{account_id}/workers/scripts/{script_name}': {
			put: {summary: 'Upload Worker Module', tags: ['Worker Script'], requestBody: {content: {'multipart/form-data': {}}}},
		},
	},
};

describe('requestCode', () => {
	test('sends the request as it is, with the account the call is for in place of {account_id}', async () => {
		const {answer, sent} = await execute(requestCode({method: 'POST', path: '/accounts/{account_id}/d1/database', body: {name: 'notes'}}), 'acc-1');

		expect(sent).toEqual([{method: 'POST', path: '/accounts/acc-1/d1/database', body: {name: 'notes'}}]);
		expect(answer).toEqual({success: true, result: []});
	});

	test('reads no account for a path without one, as listing zones with several accounts', async () => {
		const {sent} = await execute(requestCode({method: 'GET', path: '/zones?name=example.com'}), undefined);
		expect(sent).toEqual([{method: 'GET', path: '/zones?name=example.com'}]);
	});

	test('a path for one account fails asking for it, where none was named and there are several', async () => {
		const code = requestCode({method: 'GET', path: '/accounts/{account_id}/workers/scripts'});
		await expect(execute(code, undefined)).rejects.toThrow('give the Account ID');
	});

	test('nothing a request says runs as code', async () => {
		const path = "/zones'); globalThis.ran = true; ('";
		const {sent} = await execute(requestCode({method: 'GET', path, body: {query: '`${globalThis.ran = true}`'}}), undefined);

		expect(sent[0]?.path).toBe(path);
		expect('ran' in globalThis).toBe(false);
	});
});

describe('findEndpoints', () => {
	test('lists every endpoint with each word in its method, path, summary or product', () => {
		expect(findEndpoints('dns records', SPEC, 50)).toBe('GET /zones/{zone_id}/dns_records List DNS Records\nPOST /zones/{zone_id}/dns_records Create DNS Record');
		expect(findEndpoints('Create DNS', SPEC, 50)).toBe('POST /zones/{zone_id}/dns_records Create DNS Record');
	});

	test('one endpoint answers with its parameters and JSON body; another kind of body by its type', () => {
		expect(findEndpoints('post /zones/{zone_id}/dns_records', SPEC, 50)).toEqual({
			endpoint: 'POST /zones/{zone_id}/dns_records',
			summary: 'Create DNS Record',
			description: undefined,
			parameters: [{name: 'zone_id', in: 'path'}],
			body: {type: 'object', required: ['type', 'name']},
		});
		expect(findEndpoints('PUT /accounts/{account_id}/workers/scripts/{script_name}', SPEC, 50)).toMatchObject({body: 'multipart/form-data'});
	});

	test('says when nothing has every word, and how many it left out past the first', () => {
		expect(findEndpoints('magic transit', SPEC, 50)).toBe('No endpoint has every one of those words: try fewer, or other words for the product.');
		expect(findEndpoints('zone', SPEC, 1)).toBe('GET /zones List Zones\nand 2 more: add words to narrow it');
	});

	test('runs as the code sent to search, with nothing from around it', async () => {
		const run = new Function('spec', `return (${endpointsCode('dns records')})();`);
		expect(await run(SPEC)).toBe(findEndpoints('dns records', SPEC, 50));
	});
});

describe('requestPath', () => {
	test("takes a path as the API reference writes it, or with the API's address before it", () => {
		expect(requestPath(' /zones ').unwrap()).toBe('/zones');
		expect(requestPath('https://api.cloudflare.com/client/v4/zones/z1/dns_records').unwrap()).toBe('/zones/z1/dns_records');
	});

	test('refuses anything else', () => {
		expect(requestPath('zones').unwrapErr().kind).toBe('validation_error');
		expect(requestPath('https://example.com/zones').unwrapErr().kind).toBe('validation_error');
		expect(requestPath('/zones and more').unwrapErr().kind).toBe('validation_error');
	});
});

test('isGraphqlPath', () => {
	expect(isGraphqlPath('/graphql')).toBe(true);
	expect(isGraphqlPath('/graphql/')).toBe(true);
	expect(isGraphqlPath('/graphql-thing')).toBe(false);
	expect(isGraphqlPath('/zones/graphql')).toBe(false);
});

test("a failed request is Cloudflare's words, for the model", () => {
	const error = CLOUDFLARE.toolError?.('Error: Cloudflare API error: GET /zones/z1 returned HTTP 404: 7003: Could not route to /zones/z1');
	expect(error).toMatchObject({kind: 'validation_error', message: 'Cloudflare turned it down: Cloudflare API error: GET /zones/z1 returned HTTP 404: 7003: Could not route to /zones/z1'});
});
