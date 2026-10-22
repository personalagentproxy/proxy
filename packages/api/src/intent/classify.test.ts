import {beforeEach, describe, expect, mock, spyOn, test} from 'bun:test';

const mockEnv: {TYPESAFE_API_KEY?: string; OPENROUTER_KEY?: string} = {};
mock.module('../utils/env', () => ({env: mockEnv}));

const text = 'Create a calendar invite with Jon Burke and Jacky Doe at One Boulevard Plaza at 7pm tomorrow';

// An organization with no experiment on, and one with Ask.
const NOBODY = {experiments: []};
const WITH_ASK = {experiments: ['ask' as const]};

// What Jev picks, and what OpenRouter answers: the model's JSON as the message's text.
let choice = '';
let content = '';
let jevStatus = 200;
let openRouterStatus = 200;
const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async (input: string) => {
	if (input.startsWith('https://api.typesafe.ai/')) {
		return jevStatus === 200
			? Response.json({model: 'jev-1.13.0', answers: {widget: {type: 'choice', choice, confidence: 0.9, probabilities: {[choice]: 0.9}}}, usage: {input_tokens: 1, output_tokens: 1}})
			: Response.json({error: 'down'}, {status: jevStatus});
	}
	return openRouterStatus === 200 ? Response.json({choices: [{message: {content}}], provider: 'Cerebras'}) : Response.json({error: {message: 'down'}}, {status: openRouterStatus});
}) as unknown as typeof fetch);

function pick(widget: string) {
	choice = widget;
}

function answer(values: Record<string, string | string[] | string[][] | null>) {
	content = JSON.stringify(values);
}

// The calls made to `host`, each with its headers and body.
function calls(host: string) {
	return fetchSpy.mock.calls.filter(([url]) => String(url).startsWith(host)).map(([, init]) => ({headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body))}));
}

// The body of the request last made to Jev.
function asked(): {model: string; state: string; questions: {widget: {type: string; instructions: string; criteria: Record<string, string>}}} {
	return calls('https://api.typesafe.ai/').at(-1)?.body;
}

// The body of the request last made to OpenRouter.
function sent(): {
	model: string;
	messages: Array<{role: string; content: string}>;
	provider: {order: string[]; data_collection: string; zdr: boolean};
	response_format: {json_schema: {schema: {required: string[]; properties: Record<string, object>}}};
} {
	return calls('https://openrouter.ai/').at(-1)?.body;
}

beforeEach(() => {
	fetchSpy.mockClear();
	mockEnv.TYPESAFE_API_KEY = 'ts-1';
	mockEnv.OPENROUTER_KEY = 'sk-or-1';
	jevStatus = 200;
	openRouterStatus = 200;
	pick('new_event');
	answer({attendees: ['Jon Burke', ' Jacky Doe ', 'Jon Burke'], location: 'One Boulevard Plaza', title: null});
});

describe('pickIntent', () => {
	test('asks Jev which widget fits, among those offered, incomplete and none, and fills nothing in', async () => {
		const {pickIntent} = await import('./classify');
		expect((await pickIntent(text, NOBODY)).unwrap()).toMatchObject({widget: 'new_event'});

		const [jev] = calls('https://api.typesafe.ai/');
		expect(jev?.headers.authorization).toBe('Bearer ts-1');
		const body = asked();
		expect(body.model).toBe('jev-1.13.0');
		expect(body.state).toBe(text);
		expect(body.questions.widget.type).toBe('choice');
		expect(Object.keys(body.questions.widget.criteria)).toEqual([
			'new_event',
			'change_event',
			'show_calendar',
			'find_person',
			'write_email',
			'reply_email',
			'find_email',
			'find_file',
			'calculate',
			'convert_units',
			'show_balances',
			'find_transactions',
			'incomplete',
			'none',
		]);
		expect(body.questions.widget.criteria.find_file).toBe('Find or open a file, document, spreadsheet or presentation in Drive');
		expect(body.questions.widget.criteria.incomplete).toContain('cut off');
		expect(calls('https://openrouter.ai/')).toHaveLength(0);
	});

	test('offers Ask only to an organization with the ask experiment, and fills it in only for one', async () => {
		const {pickIntent, fillIntent} = await import('./classify');
		pick('ask');

		expect((await pickIntent('what did I talk to sam about yesterday', WITH_ASK)).unwrap()).toMatchObject({widget: 'ask'});
		expect(asked().questions.widget.criteria.ask).toContain('Ask what one meeting');

		expect((await pickIntent('what did I talk to sam about yesterday', NOBODY)).unwrap()).toMatchObject({widget: 'none'});
		expect(asked().questions.widget.criteria).not.toHaveProperty('ask');

		fetchSpy.mockClear();
		expect((await fillIntent('what did I talk to sam about yesterday', 'ask', NOBODY)).unwrapErr()).toMatchObject({kind: 'not_found', resource: 'widget', id: 'ask'});
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	test('answers incomplete and none as Jev picks them, and a widget there is no such of as none', async () => {
		const {pickIntent} = await import('./classify');
		for (const [picked, widget] of [
			['incomplete', 'incomplete'],
			['none', 'none'],
			['make_coffee', 'none'],
		]) {
			pick(picked ?? '');
			expect((await pickIntent('hi', NOBODY)).unwrap()).toMatchObject({widget});
		}
	});

	test('Jev failing is a provider out of reach', async () => {
		const {pickIntent} = await import('./classify');
		jevStatus = 503;
		expect((await pickIntent(text, NOBODY)).unwrapErr().kind).toBe('provider_unreachable');
	});
});

describe('fillIntent', () => {
	test("asks gpt-oss-120b, on Cerebras first, for the widget's fields alone", async () => {
		const {fillIntent} = await import('./classify');
		await fillIntent(text, 'new_event', NOBODY);

		const body = sent();
		expect(body.model).toBe('openai/gpt-oss-120b');
		expect(body.provider.order).toEqual(['Cerebras', 'Groq']);
		expect(body.provider.data_collection).toBe('deny');
		expect(body.provider.zdr).toBe(true);
		expect(body.messages[1]).toEqual({role: 'user', content: text});
		expect(body.messages[0]?.content).toContain('Fill in the fields of the New event widget');
		expect(body.messages[0]?.content).toContain('- attendees (list): each person to invite');
		expect(body.messages[0]?.content).not.toContain('find_file');
		expect(body.response_format.json_schema.schema.required).toEqual(['attendees', 'location', 'title']);
		expect(calls('https://api.typesafe.ai/')).toHaveLength(0);
	});

	test("answers the widget's fields, each value trimmed and once", async () => {
		const {fillIntent} = await import('./classify');
		const filled = (await fillIntent(text, 'new_event', NOBODY)).unwrap();

		expect(filled.fields).toEqual([
			{id: 'attendees', name: 'Attendees', values: ['Jon Burke', 'Jacky Doe']},
			{id: 'location', name: 'Location', values: ['One Boulevard Plaza']},
			{id: 'title', name: 'Title', values: []},
		]);
	});

	test('answers search terms as each one\'s words joined by " | "', async () => {
		answer({from: null, about: [['flight', ' itinerary ', 'e|ticket'], ['SFO'], []]});
		const {fillIntent} = await import('./classify');
		const filled = (await fillIntent('find the email about my flight to sfo', 'find_email', NOBODY)).unwrap();

		expect(filled.fields).toEqual([
			{id: 'from', name: 'From', values: []},
			{id: 'about', name: 'About', values: ['flight | itinerary | e ticket', 'SFO']},
		]);
		expect(sent().response_format.json_schema.schema.properties.about).toEqual({type: 'array', items: {type: 'array', items: {type: 'string'}}});
	});

	test('fills a bank widget in, and none for a widget there is no such of', async () => {
		const {fillIntent} = await import('./classify');
		answer({merchant: 'uber', category: 'TRANSPORTATION', flow: 'out', transactionAccount: null});

		expect((await fillIntent('uber charges this month', 'find_transactions', NOBODY)).unwrap().fields).toMatchObject([
			{id: 'merchant', values: ['uber']},
			{id: 'category', values: ['TRANSPORTATION']},
			{id: 'flow', values: ['out']},
			{id: 'transactionAccount', values: []},
		]);
		expect(sent().messages[0]?.content).toContain('FOOD_AND_DRINK (restaurants, groceries');

		fetchSpy.mockClear();
		for (const widget of ['none', 'make_coffee']) {
			expect((await fillIntent('uber charges this month', widget, NOBODY)).unwrapErr()).toMatchObject({kind: 'not_found', resource: 'widget', id: widget});
		}
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	test('holds a unit to the units there are', async () => {
		answer({amount: '5', fromUnit: 'mi', toUnit: 'km'});
		const {fillIntent} = await import('./classify');
		await fillIntent('5 miles in km', 'convert_units', NOBODY);

		const properties = sent().response_format.json_schema.schema.properties as Record<string, {enum?: Array<string | null>}>;
		expect(properties.fromUnit?.enum).toContain('mi');
		expect(properties.toUnit?.enum).toContain(null);
	});

	test('OpenRouter failing, or the model answering outside the form, is a provider out of reach', async () => {
		const {fillIntent} = await import('./classify');

		openRouterStatus = 503;
		expect((await fillIntent(text, 'new_event', NOBODY)).unwrapErr().kind).toBe('provider_unreachable');
		openRouterStatus = 200;
		content = 'Sure! Here is the form:';
		expect((await fillIntent(text, 'new_event', NOBODY)).unwrapErr().kind).toBe('provider_unreachable');
	});
});

test('picking and filling in are unavailable without either key, and ask nothing', async () => {
	const {fillIntent, pickIntent} = await import('./classify');

	for (const key of ['TYPESAFE_API_KEY', 'OPENROUTER_KEY'] as const) {
		mockEnv.TYPESAFE_API_KEY = 'ts-1';
		mockEnv.OPENROUTER_KEY = 'sk-or-1';
		delete mockEnv[key];
		for (const result of [await pickIntent(text, NOBODY), await fillIntent(text, 'new_event', NOBODY)]) {
			expect(result.unwrapErr()).toMatchObject({kind: 'unavailable', message: 'The home page is not set up: set `TYPESAFE_API_KEY` and `OPENROUTER_KEY`.'});
		}
	}
	expect(fetchSpy).not.toHaveBeenCalled();
});
