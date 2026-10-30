import {describe, expect, mock, test} from 'bun:test';

import {INTEGRATIONS, type Integration} from '@proxy/integrations';

import type {ApiIntegration, ConnectRoutes} from './integration';

// Only the modules are looked at here, never run: nothing reads the environment.
mock.module('../utils/env', () => ({env: {}}));

const {apiIntegration, apiIntegrations} = await import('./integrations');

// How the catalog says an integration is connected, as the web app reads it, named as the module's
// routes are; none for the vault, which is never connected.
function connectedBy(integration: Integration): ConnectRoutes['kind'] | null {
	if (integration.signIn) {
		return 'signIn';
	}
	if (integration.form === 'email' || integration.form === 'database') {
		return 'form';
	}
	return integration.form ?? null;
}

function moduleOf(integration: Integration): ApiIntegration {
	const found = apiIntegration(integration.id);
	if (!found) {
		throw new Error(`No module for ${integration.id}`);
	}
	return found;
}

describe('apiIntegrations', () => {
	test('has a module for every integration of the catalog, and none of its own', () => {
		expect(
			apiIntegrations()
				.map((integration) => integration.id)
				.toSorted(),
		).toEqual(INTEGRATIONS.map((integration) => integration.id).toSorted());
	});

	for (const integration of INTEGRATIONS) {
		test(`${integration.id} is connected as the catalog says, the web app's form or sign-in being its routes`, () => {
			expect(moduleOf(integration).connect?.kind ?? null).toBe(connectedBy(integration));
		});

		test(`${integration.id} has connectors only for the catalog's collections`, () => {
			const collections = integration.collections.map((collection) => collection.id);
			expect(Object.keys(moduleOf(integration).connectors).filter((id) => !collections.includes(id))).toEqual([]);
		});

		test(`${integration.id} is built on an MCP server only as itself`, () => {
			expect(moduleOf(integration).builtInMcp?.integrationId ?? integration.id).toBe(integration.id);
		});
	}
});
