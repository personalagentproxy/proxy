import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

import {describe, expect, test} from 'bun:test';
import {INTEGRATIONS} from '@proxy/integrations';

import {integrationOf, logoOf} from './integrations';

describe('integrationOf', () => {
	test('uses the Personal Agent Proxy mark for a custom MCP connection', () => {
		expect(integrationOf({integrationId: 'mcp', tools: []})?.logo).toEqual({
			src: '/favicon.svg',
		});
	});
});

describe('logoOf', () => {
	test('is the file named by the id, unless the integration has another', () => {
		expect(logoOf('exa')).toEqual({src: '/integrations/exa.svg'});
		expect(logoOf('granola')).toEqual({src: '/integrations/granola.png', fill: true});
	});

	test('every integration in the catalog has a logo file in public/, or an icon', () => {
		for (const integration of INTEGRATIONS) {
			const logo = logoOf(integration.id);
			if (!('src' in logo)) {
				continue;
			}
			const file = fileURLToPath(new URL(`../../public${logo.src}`, import.meta.url));
			expect(existsSync(file), `${integration.id} has no ${logo.src}`).toBe(true);
		}
	});
});
