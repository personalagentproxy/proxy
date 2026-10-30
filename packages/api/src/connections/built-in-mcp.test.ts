import {describe, expect, mock, test} from 'bun:test';

import {findCollection, findIntegration, INTEGRATIONS, requiredAction} from '@proxy/integrations';

mock.module('../utils/env', () => ({env: {NODE_ENV: 'production', APP_URL: 'https://app.example.com'}}));

const {builtInMcps, builtInForHost} = await import('./built-in-mcp');
const {builtInHosts} = await import('./mcp/built-in');

const BUILT_IN_MCP = builtInMcps();

describe('builtInMcps', () => {
	test("every entry is an integration of the catalog's, and its defaults and tools' actions are its actions", () => {
		for (const builtIn of BUILT_IN_MCP) {
			const integration = findIntegration(builtIn.integrationId);
			expect(integration?.custom, builtIn.integrationId).toBeUndefined();
			const actions = integration?.actions.map((action) => action.id) ?? [];
			expect(actions, builtIn.integrationId).toEqual(expect.arrayContaining(builtIn.defaults));
			for (const [name, tool] of Object.entries(builtIn.tools)) {
				expect(tool.actions.length, `${builtIn.integrationId} ${name}`).toBeGreaterThan(0);
				expect(actions, `${builtIn.integrationId} ${name}`).toEqual(expect.arrayContaining(tool.actions));
			}
		}
	});

	test("every tool's runs become requests its collections have, needing one of the tool's own actions", () => {
		for (const builtIn of BUILT_IN_MCP) {
			const integration = findIntegration(builtIn.integrationId);
			for (const [name, tool] of Object.entries(builtIn.tools)) {
				const run = tool.run?.(null);
				if (!run || !integration) {
					continue;
				}
				const collection = findCollection(integration, run.collectionId);
				expect(collection, `${builtIn.integrationId} ${name}`).toBeDefined();
				expect(tool.actions, `${builtIn.integrationId} ${name}`).toContain(collection ? (requiredAction(collection, run.operation) ?? '') : '');
			}
		}
	});

	test('the catalog marks exactly Google and the integrations built on their MCP servers as signed in to, for the web app', () => {
		const signedIn: string[] = INTEGRATIONS.filter((integration) => integration.signIn).map((integration) => integration.id);
		expect(signedIn.toSorted()).toEqual(['google', ...BUILT_IN_MCP.map((builtIn) => builtIn.integrationId)].toSorted());
	});

	test('exactly the integrations the catalog says take an API key do, and are signed in to', () => {
		const keyed = INTEGRATIONS.filter((integration) => integration.apiKey);
		expect(keyed.map((integration) => integration.id).toSorted()).toEqual(
			BUILT_IN_MCP.filter((builtIn) => builtIn.apiKey)
				.map((builtIn) => builtIn.integrationId)
				.toSorted(),
		);
		for (const integration of keyed) {
			expect(integration.signIn, integration.id).toBe(true);
			expect(new URL(integration.apiKey?.keysUrl ?? '').protocol, integration.id).toBe('https:');
		}
	});

	test('the catalog marks exactly the integrations that say nothing of who signed in as anonymous, for the web app', () => {
		const anonymous: string[] = INTEGRATIONS.filter((integration) => integration.anonymous).map((integration) => integration.id);
		expect(anonymous.toSorted()).toEqual(
			BUILT_IN_MCP.filter((builtIn) => !builtIn.account)
				.map((builtIn) => builtIn.integrationId)
				.toSorted(),
		);
	});

	test('no two integrations take over the same host', () => {
		const hosts = BUILT_IN_MCP.flatMap(builtInHosts);
		expect(new Set(hosts).size).toBe(hosts.length);
	});

	test('finds the integration by host, as an address writes it', () => {
		expect(builtInForHost('mcp.linear.app')?.integrationId).toBe('linear');
		expect(builtInForHost('Search.Parallel.ai')?.integrationId).toBe('parallel');
		expect(builtInForHost('mcp.example.com')).toBeUndefined();
	});
});
