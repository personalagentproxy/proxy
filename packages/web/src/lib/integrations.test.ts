import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

import {describe, expect, test} from 'bun:test';
import {INTEGRATIONS} from '@proxy/integrations';

import {integrationOf, logoOf} from './integrations';

describe('integrationOf', () => {
	test("uses the icon of a custom MCP server's site, with the Personal Agent Proxy mark to fall back on", () => {
		expect(
			integrationOf({integrationId: 'mcp', account: 'mcp.example.com:8443/mcp', tools: []})?.logo,
		).toEqual({src: '/api/favicons/mcp.example.com', fallback: '/favicon.svg'});
	});

	test('keeps the logo of every other integration', () => {
		expect(integrationOf({integrationId: 'exa', account: 'Signed in'})?.logo).toEqual({
			src: '/integrations/exa.svg',
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
