import {beforeEach, describe, expect, mock, test} from 'bun:test';
import {Ok} from 'ts-results-es';

const pickIntent = mock();
const fillIntent = mock();
// The widgets offered, as told apart by whether Chat's are among them.
const widgetsOffered = (withChat: boolean) => (withChat ? ['with chat'] : ['without chat']);

mock.module('./classify', () => ({pickIntent, fillIntent, widgetsOffered}));

let experiments: string[] = [];
mock.module('../utils/user-org', () => ({requireViewer: async () => Ok({orgId: 'org-1', userId: 'user-1', slug: 'org-1', name: 'Workspace', role: 'owner', onboarded: true, experiments})}));

function makeRequest(body: unknown) {
	return {user: {userId: 'user-1'}, params: {org: 'org-1'}, body} as never;
}

beforeEach(() => {
	mock.clearAllMocks();
	experiments = [];
	pickIntent.mockResolvedValue(Ok({widget: 'none', ms: 1}));
	fillIntent.mockResolvedValue(Ok({fields: [], ms: 1}));
});

describe('handlePickIntentRoute', () => {
	test('picks among the widgets for a member of the organization, for the text trimmed', async () => {
		const {handlePickIntentRoute} = await import('./route');
		const result = await handlePickIntentRoute(makeRequest({text: '  who is hugo  '}));

		expect(result.isOk()).toBe(true);
		expect(pickIntent).toHaveBeenCalledWith('who is hugo', ['without chat']);
	});

	test('offers the widgets that work with Chat’s agents in an organization that has Chat', async () => {
		const {handleFillIntentRoute, handlePickIntentRoute} = await import('./route');
		experiments = ['harness'];

		await handlePickIntentRoute(makeRequest({text: 'add an agent for my finances'}));
		await handleFillIntentRoute(makeRequest({text: 'add an agent for my finances', widget: 'new_agent'}));

		expect(pickIntent).toHaveBeenCalledWith('add an agent for my finances', ['with chat']);
		expect(fillIntent).toHaveBeenCalledWith('add an agent for my finances', 'new_agent', ['with chat']);
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
	test("fills in the widget's fields for a member of the organization, from the text trimmed", async () => {
		const {handleFillIntentRoute} = await import('./route');
		const result = await handleFillIntentRoute(makeRequest({text: '  who is hugo  ', widget: 'find_person'}));

		expect(result.isOk()).toBe(true);
		expect(fillIntent).toHaveBeenCalledWith('who is hugo', 'find_person', ['without chat']);
	});

	test('refuses a request without a widget, or with text that is empty or past 500 characters', async () => {
		const {handleFillIntentRoute} = await import('./route');

		for (const body of [{text: 'who is hugo'}, {text: 'who is hugo', widget: ''}, {text: '   ', widget: 'find_person'}, {text: 'a'.repeat(501), widget: 'find_person'}]) {
			expect((await handleFillIntentRoute(makeRequest(body))).unwrapErr().kind).toBe('parse_error');
		}
		expect(fillIntent).not.toHaveBeenCalled();
	});
});
