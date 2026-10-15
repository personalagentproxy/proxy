import {beforeEach, describe, expect, mock, test} from 'bun:test';
import {Ok} from 'ts-results-es';

const classifyIntent = mock();

mock.module('./classify', () => ({classifyIntent}));

function makeRequest(body: unknown) {
	return {user: {userId: 'user-1'}, body} as never;
}

beforeEach(() => {
	mock.clearAllMocks();
	classifyIntent.mockResolvedValue(Ok({widget: 'none', fields: [], ms: 1}));
});

describe('handleClassifyIntentRoute', () => {
	test('classifies the text, trimmed', async () => {
		const {handleClassifyIntentRoute} = await import('./route');
		const result = await handleClassifyIntentRoute(makeRequest({text: '  who is hugo  '}));

		expect(result.isOk()).toBe(true);
		expect(classifyIntent).toHaveBeenCalledWith('who is hugo');
	});

	test('refuses empty text, and text past 500 characters, without asking the models', async () => {
		const {handleClassifyIntentRoute} = await import('./route');

		for (const text of ['   ', 'a'.repeat(501)]) {
			expect((await handleClassifyIntentRoute(makeRequest({text}))).unwrapErr().kind).toBe('parse_error');
		}
		expect(classifyIntent).not.toHaveBeenCalled();
	});
});
