import {describe, expect, test} from 'bun:test';
import {agentErrorMessage} from '@/lib/agent-errors';

const failed = (status: number, body: Record<string, string>) => ({
	kind: 'http' as const,
	url: '/api/agent/records',
	status,
	body,
});

describe('agentErrorMessage', () => {
	test('an error with the api’s own words says them, nothing found or out of reach alike', () => {
		const missing = {
			error: 'not_found',
			resource: 'page',
			message: 'Exa found no page at https://example.com/gone.',
		};
		const slow = {
			error: 'provider_unreachable',
			message: 'Exa timed out reading https://example.com/slow.',
		};

		expect(agentErrorMessage(failed(404, missing))).toBe(
			'Exa found no page at https://example.com/gone.',
		);
		expect(agentErrorMessage(failed(502, slow))).toBe(
			'Exa timed out reading https://example.com/slow.',
		);
	});

	test('an error without words of its own reads as before', () => {
		expect(agentErrorMessage(failed(404, {error: 'not_found', resource: 'record'}))).toBe(
			'It is not there anymore, or the mailbox has no folder for it.',
		);
		expect(agentErrorMessage(failed(502, {error: 'provider_unreachable'}))).toBe(
			'The provider could not be reached. Try again in a moment.',
		);
	});
});
