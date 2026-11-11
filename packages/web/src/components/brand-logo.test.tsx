/// <reference types="bun" />

import {afterEach, describe, expect, test} from 'bun:test';
import {act, cleanup, render} from '@testing-library/react';
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@proxy/ui/components/select';
import {AgentLogo, IntegrationLogo} from '@/components/brand-logo';
import {findIntegration} from '@/lib/integrations';

afterEach(() => {
	cleanup();
});

describe('AgentLogo', () => {
	test('uses the Personal Agent Proxy mark for a custom MCP agent', () => {
		const {container} = render(<AgentLogo providerId="custom" />);

		expect(container.querySelector('img')?.getAttribute('src')).toBe('/favicon.svg');
		expect(container.querySelector('svg')).toBeNull();
	});

	test('draws the built-in agent, which the Chat page’s personas act through, as a head', () => {
		const {container} = render(<AgentLogo providerId="proxy" />);

		expect(container.querySelector('canvas')).not.toBeNull();
		expect(container.querySelector('img')).toBeNull();
	});
});

describe('IntegrationLogo', () => {
	test('keeps a built-in icon color inside a focused select item', async () => {
		const vault = findIntegration('vault');
		expect(vault).toBeDefined();
		if (!vault) {
			return;
		}

		await act(async () => {
			render(
				<Select defaultOpen defaultValue="vault">
					<SelectTrigger>
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="vault">
							<IntegrationLogo integration={vault} />
							Vault
						</SelectItem>
					</SelectContent>
				</Select>,
			);
			await Promise.resolve();
		});
		const item = document.querySelector('[data-slot="select-item"]');
		expect(item).toBeInstanceOf(HTMLElement);
		if (!(item instanceof HTMLElement)) {
			return;
		}
		item.focus();
		const icon = item.querySelector('svg');

		expect(document.activeElement).toBe(item);
		expect(item.className).toContain('focus:**:not-data-[preserve-color]:text-accent-foreground');
		expect(icon?.hasAttribute('data-preserve-color')).toBe(true);
		expect(icon?.classList).toContain('text-foreground');
	});
});
