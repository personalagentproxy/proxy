import {beforeEach, describe, expect, mock, test} from 'bun:test';
import {Ok} from 'ts-results-es';

const pickIntent = mock();
const fillIntent = mock();

mock.module('./classify', () => ({pickIntent, fillIntent}));

mock.module('../utils/user-org', () => ({requireViewer: async () => Ok({orgId: 'org-1', userId: 'user-1', slug: 'org-1', name: 'Workspace', role: 'owner', onboarded: true, experiments: []})}));

function makeRequest(body: unknown) {
	return {user: {userId: 'user-1'}, params: {org: 'org-1'}, body} as never;
}

beforeEach(() => {
	mock.clearAllMocks();
	pickIntent.mockResolvedValue(Ok({widget: 'none', ms: 1}));
	fillIntent.mockResolvedValue(Ok({fields: [], ms: 1}));
});

describe('handlePickIntentRoute', () => {
	test("picks among the widgets the person's organization is offered, for the text trimmed", async () => {
		const {handlePickIntentRoute} = await import('./route');
		const result = await handlePickIntentRoute(makeRequest({text: '  who is hugo  '}));

		expect(result.isOk()).toBe(true);
		expect(pickIntent).toHaveBeenCalledWith('who is hugo', expect.objectContaining({userId: 'user-1', experiments: []}));
	});

	test('refuses empty text, and text past 500 characters, without asking the models', async () => {
		const {handlePickIntentRoute} = await import('./route');

		for (const text of ['   ', 'a'.repeat(501)]) {
			expect((await handlePickIntentRoute(makeRequest({text}))).unwrapErr().kind).toBe('parse_error');
		}
		expect(pickIntent).not.toHaveBeenCalled();
	});
});

describe('handleFillIntentRoute', () => {
	test("fills in the widget's fields for the person's organization, from the text trimmed", async () => {
		const {handleFillIntentRoute} = await import('./route');
		const result = await handleFillIntentRoute(makeRequest({text: '  who is hugo  ', widget: 'find_person'}));

		expect(result.isOk()).toBe(true);
		expect(fillIntent).toHaveBeenCalledWith('who is hugo', 'find_person', expect.objectContaining({userId: 'user-1', experiments: []}));
	});

	test('refuses a request without a widget, or with text that is empty or past 500 characters', async () => {
		const {handleFillIntentRoute} = await import('./route');

		for (const body of [{text: 'who is hugo'}, {text: 'who is hugo', widget: ''}, {text: '   ', widget: 'find_person'}, {text: 'a'.repeat(501), widget: 'find_person'}]) {
			expect((await handleFillIntentRoute(makeRequest(body))).unwrapErr().kind).toBe('parse_error');
		}
		expect(fillIntent).not.toHaveBeenCalled();
	});
});
