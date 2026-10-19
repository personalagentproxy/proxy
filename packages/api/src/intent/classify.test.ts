import {beforeEach, describe, expect, mock, spyOn, test} from 'bun:test';

const mockEnv: {OPENROUTER_KEY?: string} = {};
mock.module('../utils/env', () => ({env: mockEnv}));

const text = 'Create a calendar invite with Jon Burke and Jacky Doe at One Boulevard Plaza at 7pm tomorrow';

// An organization with no experiment on, and one with banks.
const NOBODY = {experiments: []};
const WITH_BANKS = {experiments: ['plaid' as const]};

// What OpenRouter answers: the model's JSON as the message's text.
let content = '';
let status = 200;
const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async () =>
	status === 200 ? Response.json({choices: [{message: {content}}], provider: 'Cerebras'}) : Response.json({error: {message: 'down'}}, {status})) as unknown as typeof fetch);

function answer(values: Record<string, string | string[] | string[][] | null>) {
	content = JSON.stringify(values);
}

// The body of the request made to OpenRouter.
function sent(): {
	model: string;
	messages: Array<{role: string; content: string}>;
	provider: {order: string[]; data_collection: string};
	response_format: {json_schema: {schema: {required: string[]; properties: {widget: {enum: string[]}}}}};
} {
	return JSON.parse(String(fetchSpy.mock.calls.at(-1)?.[1]?.body));
}

beforeEach(() => {
	fetchSpy.mockClear();
	mockEnv.OPENROUTER_KEY = 'sk-or-1';
	status = 200;
	answer({
		widget: 'new_event',
		attendees: ['Jon Burke', ' Jacky Doe ', 'Jon Burke'],
		location: 'One Boulevard Plaza',
		title: null,
		person: null,
		to: [],
		subject: null,
		from: null,
		about: null,
		name: null,
		owner: null,
	});
});

describe('classifyIntent', () => {
	test('asks gpt-oss-120b, on Cerebras first, for the widget and every field in one answer', async () => {
		const {classifyIntent} = await import('./classify');
		await classifyIntent(text, NOBODY);

		const body = sent();
		expect(body.model).toBe('openai/gpt-oss-120b');
		expect(body.provider.order).toEqual(['Cerebras', 'Groq']);
		expect(body.provider.data_collection).toBe('deny');
		expect(body.messages[1]).toEqual({role: 'user', content: text});
		expect(body.messages[0]?.content).toContain('- find_file: Find or open a file');
		const schema = body.response_format.json_schema.schema;
		expect(schema.properties.widget.enum).toEqual([
			'new_event',
			'change_event',
			'show_calendar',
			'find_person',
			'write_email',
			'find_email',
			'find_file',
			'calculate',
			'convert_units',
			'incomplete',
			'none',
		]);
		expect(schema.required).toEqual([
			'widget',
			'attendees',
			'location',
			'title',
			'changeWith',
			'changeEvent',
			'changeFrom',
			'changeTo',
			'invite',
			'uninvite',
			'newTitle',
			'newLocation',
			'meetingWith',
			'eventName',
			'person',
			'to',
			'subject',
			'body',
			'from',
			'about',
			'name',
			'owner',
			'expression',
			'amount',
			'fromUnit',
			'toUnit',
		]);
	});

	test("answers the picked widget's fields alone, each value trimmed and once", async () => {
		const {classifyIntent} = await import('./classify');
		const intent = (await classifyIntent(text, NOBODY)).unwrap();

		expect(intent.widget).toBe('new_event');
		expect(intent.fields).toEqual([
			{id: 'attendees', name: 'Attendees', values: ['Jon Burke', 'Jacky Doe']},
			{id: 'location', name: 'Location', values: ['One Boulevard Plaza']},
			{id: 'title', name: 'Title', values: []},
		]);
	});

	test('answers search terms as each one\'s words joined by " | "', async () => {
		answer({widget: 'find_email', from: null, about: [['flight', ' itinerary ', 'e|ticket'], ['SFO'], []]});
		const {classifyIntent} = await import('./classify');
		const intent = (await classifyIntent('find the email about my flight to sfo', NOBODY)).unwrap();

		expect(intent.fields).toEqual([
			{id: 'from', name: 'From', values: []},
			{id: 'about', name: 'About', values: ['flight | itinerary | e ticket', 'SFO']},
		]);
		const schema = sent().response_format.json_schema.schema as unknown as {properties: Record<string, object>};
		expect(schema.properties.about).toEqual({type: 'array', items: {type: 'array', items: {type: 'string'}}});
	});

	test('offers the bank widgets, and their fields, only to an organization with the plaid experiment', async () => {
		const {classifyIntent} = await import('./classify');
		await classifyIntent('how much did I spend on restaurants last month', WITH_BANKS);

		const withBanks = sent();
		expect(withBanks.messages[0]?.content).toContain('- find_transactions: Find bank or card transactions');
		expect(withBanks.messages[0]?.content).toContain('FOOD_AND_DRINK (restaurants, groceries');
		expect(withBanks.response_format.json_schema.schema.properties.widget.enum).toContain('show_balances');
		expect(withBanks.response_format.json_schema.schema.required).toEqual(expect.arrayContaining(['balanceAccount', 'merchant', 'category', 'flow', 'transactionAccount']));

		await classifyIntent('how much did I spend on restaurants last month', NOBODY);
		const without = sent();
		expect(without.messages[0]?.content).not.toContain('find_transactions');
		expect(without.response_format.json_schema.schema.properties.widget.enum).not.toContain('show_balances');
		expect(without.response_format.json_schema.schema.required).not.toContain('merchant');
	});

	test('answers a bank widget to an organization with the experiment, and none to one without', async () => {
		const {classifyIntent} = await import('./classify');
		answer({widget: 'find_transactions', merchant: 'uber', category: 'TRANSPORTATION', flow: 'out', transactionAccount: null});

		expect((await classifyIntent('uber charges this month', WITH_BANKS)).unwrap()).toMatchObject({
			widget: 'find_transactions',
			fields: [
				{id: 'merchant', values: ['uber']},
				{id: 'category', values: ['TRANSPORTATION']},
				{id: 'flow', values: ['out']},
				{id: 'transactionAccount', values: []},
			],
		});
		expect((await classifyIntent('uber charges this month', NOBODY)).unwrap()).toMatchObject({widget: 'none', fields: []});
	});

	test("every field id is one widget's alone, as the model answers them all in one object", async () => {
		const {WIDGETS} = await import('./widgets');
		const ids = WIDGETS.flatMap((widget) => widget.fields.map((field) => field.id));
		expect(new Set(ids).size).toBe(ids.length);
	});

	test('holds a unit to the units there are', async () => {
		const {classifyIntent} = await import('./classify');
		await classifyIntent('5 miles in km', NOBODY);

		const schema = sent().response_format.json_schema.schema as unknown as {properties: Record<string, {enum?: Array<string | null>}>};
		expect(schema.properties.fromUnit?.enum).toContain('mi');
		expect(schema.properties.toUnit?.enum).toContain(null);
	});

	test('none, or a widget there is no such of, has no fields', async () => {
		const {classifyIntent} = await import('./classify');
		for (const widget of ['none', 'make_coffee']) {
			answer({widget});
			expect((await classifyIntent('hi', NOBODY)).unwrap()).toMatchObject({widget: 'none', fields: []});
		}
	});

	test('tells text still being typed from a whole request no widget does', async () => {
		const {classifyIntent} = await import('./classify');
		answer({widget: 'incomplete'});

		expect((await classifyIntent('find the', NOBODY)).unwrap()).toMatchObject({widget: 'incomplete', fields: []});
		expect(sent().messages[0]?.content).toContain('- incomplete: the text is cut off');
	});

	test('is unavailable without a key, and asks nothing', async () => {
		delete mockEnv.OPENROUTER_KEY;
		const {classifyIntent} = await import('./classify');

		expect((await classifyIntent(text, NOBODY)).unwrapErr()).toMatchObject({kind: 'unavailable', message: 'The home page is not set up: set `OPENROUTER_KEY`.'});
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	test('OpenRouter failing, or the model answering outside the form, is a provider out of reach', async () => {
		const {classifyIntent} = await import('./classify');

		status = 503;
		expect((await classifyIntent(text, NOBODY)).unwrapErr().kind).toBe('provider_unreachable');
		status = 200;
		content = 'Sure! Here is the form:';
		expect((await classifyIntent(text, NOBODY)).unwrapErr().kind).toBe('provider_unreachable');
		answer({attendees: ['Jon']});
		expect((await classifyIntent(text, NOBODY)).unwrapErr().kind).toBe('provider_unreachable');
	});
});
