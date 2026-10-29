import {describe, expect, mock, test} from 'bun:test';

mock.module('../../utils/env', () => ({env: {NODE_ENV: 'production', APP_URL: 'https://app.example.com'}}));

// What the route answered, and the headers it set.
function makeRes() {
	const res = {
		headers: new Map<string, string>(),
		sent: undefined as unknown,
		statusCode: 200,
		setHeader: mock((name: string, value: string) => {
			res.headers.set(name.toLowerCase(), value);
		}),
		status: mock((code: number) => {
			res.statusCode = code;
			return res;
		}),
		json: mock((body: unknown) => {
			res.sent = body;
			return res;
		}),
	};
	return res;
}

describe('handleClientMetadataRoute', () => {
	test('names its own address as the client, a public one, with every MCP sign-in’s callback', async () => {
		const {handleClientMetadataRoute} = await import('./client-metadata');
		const res = makeRes();
		handleClientMetadataRoute({} as never, res as never);

		expect(res.statusCode).toBe(200);
		expect(res.headers.get('cache-control')).toBe('public, max-age=3600');
		expect(res.sent).toEqual({
			client_id: 'https://app.example.com/oauth/client-metadata.json',
			client_name: 'Personal Agent Proxy',
			client_uri: 'https://app.example.com',
			logo_uri: 'https://app.example.com/favicon.svg',
			redirect_uris: [
				'https://app.example.com/api/connections/mcp/callback',
				'https://app.example.com/api/connections/granola/callback',
				'https://app.example.com/api/connections/notion/callback',
				'https://app.example.com/api/connections/linear/callback',
				'https://app.example.com/api/connections/cloudflare/callback',
				'https://app.example.com/api/connections/exa/callback',
				'https://app.example.com/api/connections/parallel/callback',
			],
			grant_types: ['authorization_code', 'refresh_token'],
			response_types: ['code'],
			token_endpoint_auth_method: 'none',
			application_type: 'web',
		});
	});
});
