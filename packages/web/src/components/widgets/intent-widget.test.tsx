/// <reference types="bun" />

import {afterEach, beforeEach, describe, expect, mock, test} from 'bun:test';
import {cleanup, fireEvent, render, screen, waitFor, within} from '@testing-library/react';
import {MemoryRouter} from 'react-router';
import {TooltipProvider} from '@proxy/ui/components/tooltip';
import type {Intent} from '@/client/intent-client';
import {IntentWidget} from '@/components/widgets/intent-widget';
import {clearWidgetLookups, widgetsAnswer} from '@/test-widgets-api';

// Wednesday 14 October 2026, 14:30 local time.
const now = new Date(2026, 9, 14, 14, 30);

const realFetch = globalThis.fetch;
const fetchMock = mock((input: string, init?: RequestInit) =>
	Promise.resolve(widgetsAnswer(input, init) ?? Response.json({}, {status: 404})),
);

beforeEach(() => {
	fetchMock.mockClear();
	onAsk.mockClear();
	globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
	globalThis.fetch = realFetch;
	clearWidgetLookups();
	cleanup();
});

function intentWith(widget: string, fields: Record<string, string[]>): Intent {
	return {
		widget,
		fields: Object.entries(fields).map(([id, values]) => ({id, name: id, values})),
		ms: 0,
	};
}

const onAsk = mock((_text: string) => {});

function show(intent: Intent, typed = '') {
	return render(
		<MemoryRouter>
			<TooltipProvider>
				<IntentWidget intent={intent} typed={typed} now={now} onAsk={onAsk} />
			</TooltipProvider>
		</MemoryRouter>,
	);
}

function widgetNamed(name: string): HTMLElement {
	return screen.getByRole('region', {name});
}

// What a widget sent to a route of the api, as JSON.
function sentTo(path: string): unknown {
	const call = fetchMock.mock.calls.find(
		([input, init]) => input === path && init?.method === 'POST',
	);
	return JSON.parse(String(call?.[1]?.body ?? 'null'));
}

describe('IntentWidget', () => {
	test('New event: guests from the contacts, the day with what clashes, and the invite sent', async () => {
		show(
			intentWith('new_event', {attendees: ['hugo'], location: ['Nopa']}),
			'book hugo tomorrow at 3pm at Nopa',
		);

		const widget = widgetNamed('New event');
		expect(within(widget).getByRole('textbox', {name: 'Title'})).toHaveProperty(
			'value',
			'hugo and me',
		);
		expect(await within(widget).findByText(/hugo\.brandt@example\.com/)).toBeTruthy();
		expect(within(widget).getByRole('textbox', {name: 'Title'})).toHaveProperty(
			'value',
			'Hugo and me',
		);
		expect(within(widget).getByText('Nopa')).toBeTruthy();
		// Thursday 3pm sits in the calendar's focus time.
		expect(await within(widget).findByText('Clashes with Focus time')).toBeTruthy();
		// Two calendars can take it, so it says which.
		expect(within(widget).getByRole('combobox', {name: 'Calendar'})).toBeTruthy();

		fireEvent.click(within(widget).getByRole('button', {name: 'Send invite'}));
		expect(await within(widget).findByText(/Invite sent/)).toBeTruthy();
		expect(within(widget).getByRole('link', {name: 'Open'}).getAttribute('href')).toBe(
			'https://calendar.google.com/event?eid=1',
		);
		expect(sentTo('/api/widgets/events')).toEqual({
			connectionId: 'google-1',
			calendarId: 'me@example.com',
			title: 'Hugo and me',
			start: new Date(2026, 9, 15, 15, 0).toISOString(),
			end: new Date(2026, 9, 15, 15, 30).toISOString(),
			location: 'Nopa',
			guests: ['hugo.brandt@example.com'],
		});
		expect(within(widget).getByRole('button', {name: 'Send invite'})).toHaveProperty(
			'disabled',
			true,
		);
	});

	test('New event: a name several contacts have is a choice, the closest first', async () => {
		show(intentWith('new_event', {attendees: ['jacky']}), 'lunch with jacky tomorrow at 1');

		const which = await screen.findByRole('combobox', {name: 'Which jacky'});
		expect(which.textContent).toContain('Jacky Doe');
	});

	test('a widget with nothing connected to read asks to connect it, and comes back home', async () => {
		fetchMock.mockImplementationOnce(() =>
			Promise.resolve(
				Response.json({sources: [], calendars: [], events: [], target: null, failed: []}),
			),
		);
		show(intentWith('new_event', {}), 'meeting tomorrow at 2');

		const connect = await screen.findByRole('link', {name: /Connect Google/});
		expect(connect.getAttribute('href')).toBe('/api/connections/google/start?returnTo=home');
		expect(
			screen.getByText('Connect a calendar to see your day and send invites from here.'),
		).toBeTruthy();
	});

	test('Person: the contact the name means, or that there is none', async () => {
		show(intentWith('find_person', {person: ['hugo']}));
		expect(await within(widgetNamed('Person')).findByText('Hugo Brandt')).toBeTruthy();
		expect(within(widgetNamed('Person')).getByText('+49 30 5557 0123')).toBeTruthy();

		// Each address leads on, by typing what to do with it anew.
		fireEvent.click(
			within(widgetNamed('Person')).getByRole('button', {
				name: 'Find emails from hugo.brandt@example.com',
			}),
		);
		expect(onAsk).toHaveBeenLastCalledWith('find emails from hugo.brandt@example.com');
		fireEvent.click(
			within(widgetNamed('Person')).getByRole('button', {name: 'Write to hugo.brandt@example.com'}),
		);
		expect(onAsk).toHaveBeenLastCalledWith('write an email to hugo.brandt@example.com');
		cleanup();

		show(intentWith('find_person', {person: ['zed']}));
		expect(await within(widgetNamed('Person')).findByText('No contact named “zed”')).toBeTruthy();
	});

	test('Person: someone only in email, by their name and address', async () => {
		fetchMock.mockImplementationOnce(() =>
			Promise.resolve(
				Response.json({
					sources: [
						{
							connectionId: 'google-1',
							integrationId: 'google',
							account: 'me@example.com',
							name: null,
						},
					],
					failed: [],
					people: [
						{
							name: 'rita',
							matches: [
								{
									origin: 'email',
									connectionId: 'google-1',
									id: 'rita@example.com',
									name: 'Rita Alvarez',
									emails: ['rita@example.com'],
									phones: [],
									company: '',
									jobTitle: '',
									addresses: [],
									link: null,
								},
							],
						},
					],
				}),
			),
		);
		show(intentWith('find_person', {person: ['rita']}));
		const widget = widgetNamed('Person');
		expect(await within(widget).findByText('Rita Alvarez')).toBeTruthy();
		expect(within(widget).getByText('In your email, not in your contacts')).toBeTruthy();
		expect(within(widget).getByText('rita@example.com')).toBeTruthy();
		expect(within(widget).queryByRole('link', {name: 'Open contact'})).toBeNull();
	});

	test('Write email: recipients with their addresses, sent from the mailbox last written from', async () => {
		show(
			intentWith('write_email', {to: ['hugo', 'zed'], subject: ['lunch next week']}),
			'email hugo',
		);

		const widget = widgetNamed('Write email');
		expect(await within(widget).findByText('hugo.brandt@example.com')).toBeTruthy();
		expect(within(widget).getByText('no address')).toBeTruthy();
		expect(within(widget).getByRole('textbox', {name: 'Subject'})).toHaveProperty(
			'value',
			'lunch next week',
		);
		fireEvent.change(within(widget).getByRole('textbox', {name: 'Message'}), {
			target: {value: 'Free on Tuesday?'},
		});

		await waitFor(() =>
			expect(within(widget).getByRole('button', {name: 'Send'})).toHaveProperty('disabled', false),
		);
		fireEvent.click(within(widget).getByRole('button', {name: 'Send'}));
		expect(await within(widget).findByText('Sent')).toBeTruthy();
		expect(sentTo('/api/widgets/emails')).toEqual({
			connectionId: 'google-1',
			to: ['hugo.brandt@example.com'],
			subject: 'lunch next week',
			body: 'Free on Tuesday?',
			send: true,
		});
	});

	test('Find email and Find file: what they search for, and what every source finds', async () => {
		show(intentWith('find_email', {from: ['sam'], about: ['invoice']}));
		const emails = widgetNamed('Find email');
		expect(within(emails).getByText('from sam · about invoice')).toBeTruthy();
		expect(await within(emails).findByText('Sam Lee')).toBeTruthy();
		expect(within(emails).getByText('Invoice #1042 for September')).toBeTruthy();
		expect(fetchMock).toHaveBeenCalledWith(
			'/api/widgets/emails?from=sam&words=invoice',
			expect.anything(),
		);
		cleanup();

		show(intentWith('find_file', {owner: ['paul']}), 'the pricing spreadsheet paul shared');
		const files = widgetNamed('Find file');
		expect(await within(files).findByText('Pricing 2026')).toBeTruthy();
		await waitFor(() =>
			expect(fetchMock).toHaveBeenCalledWith(
				'/api/widgets/files?words=pricing&kind=Spreadsheet&owner=paul.mercer%40example.com',
				expect.anything(),
			),
		);
	});

	test('Math: works out the calculation the model read, rather than trusting the model with it', () => {
		show(intentWith('calculate', {expression: ['18% * 86.40']}));
		const widget = widgetNamed('Math');
		expect(within(widget).getByText('18% * 86.40 =')).toBeTruthy();
		expect(within(widget).getByLabelText('Result').textContent).toBe((15.552).toLocaleString());
		cleanup();

		show(intentWith('calculate', {expression: ['alert(1)']}));
		expect(within(widgetNamed('Math')).getByText('Can’t work out “alert(1)”')).toBeTruthy();
	});

	test('Convert units: into the unit asked for, else its counterpart, with others of its kind', () => {
		show(intentWith('convert_units', {amount: ['5'], fromUnit: ['mi'], toUnit: ['km']}));
		const widget = widgetNamed('Convert units');
		expect(within(widget).getByText('5 miles =')).toBeTruthy();
		expect(within(widget).getByLabelText('Result').textContent).toBe(
			`${(8.04672).toLocaleString(undefined, {maximumSignificantDigits: 6})} kilometres`,
		);
		expect(within(widget).getByLabelText('Also').textContent).toContain('ft');
		expect(within(widget).getByLabelText('Also').textContent).not.toContain('mm');
		cleanup();

		show(intentWith('convert_units', {amount: ['72'], fromUnit: ['f']}));
		expect(within(widgetNamed('Convert units')).getByLabelText('Result').textContent).toBe(
			`${(22.2222).toLocaleString(undefined, {maximumSignificantDigits: 6})} °C`,
		);
		cleanup();

		// Kilograms in miles is no conversion: the counterpart is taken instead.
		show(intentWith('convert_units', {amount: ['2'], fromUnit: ['kg'], toUnit: ['mi']}));
		expect(within(widgetNamed('Convert units')).getByLabelText('Result').textContent).toContain(
			'pounds',
		);
	});

	test("Convert units: money at the day's rates, a dollar into euros when no currency is said", async () => {
		show(intentWith('convert_units', {amount: ['56'], fromUnit: ['usd'], toUnit: ['eur']}));
		const widget = widgetNamed('Convert units');
		const euros = new Intl.NumberFormat(undefined, {style: 'currency', currency: 'EUR'}).format(
			56 / 1.1195,
		);
		expect((await within(widget).findByLabelText('Result')).textContent).toBe(euros);
		expect(within(widget).getByLabelText('Also').textContent).toContain('£');
		expect(within(widget).getByText(/European Central Bank rates of/)).toBeTruthy();
	});

	test('Find file: the kind said is a preference, and files with the words inside say so', async () => {
		fetchMock.mockImplementationOnce(() =>
			Promise.resolve(
				Response.json({
					sources: [
						{
							connectionId: 'google-1',
							integrationId: 'google',
							account: 'me@example.com',
							name: null,
						},
					],
					failed: [],
					files: [
						{
							connectionId: 'google-1',
							id: 'd1',
							name: 'Kickoff notes',
							kind: 'Document',
							owner: 'Me',
							modified: '2026-10-01T00:00:00.000Z',
							link: null,
							matched: 'content',
						},
					],
				}),
			),
		);
		show(intentWith('find_file', {name: ['leichtle doc']}), 'find the leichtle doc');
		const widget = widgetNamed('Find file');
		expect(within(widget).getByText('named leichtle · documents first')).toBeTruthy();
		expect(
			await within(widget).findByText('No file is named “leichtle”; these have it inside.'),
		).toBeTruthy();
	});

	test('shows nothing when no widget fits', () => {
		const {container} = show(intentWith('none', {}));
		expect(container.innerHTML).toBe('');
	});
});
