/// <reference types="bun" />

import {afterEach, describe, expect, test} from 'bun:test';
import {cleanup, render} from '@testing-library/react';
import {AgentLogo} from '@/components/brand-logo';

afterEach(() => {
	cleanup();
});

describe('AgentLogo', () => {
	test('uses the Personal Agent Proxy mark for a custom MCP agent', () => {
		const {container} = render(<AgentLogo providerId="custom" />);

		expect(container.querySelector('img')?.getAttribute('src')).toBe('/favicon.svg');
		expect(container.querySelector('svg')).toBeNull();
	});
});
