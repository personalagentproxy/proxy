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

	test('Calendar: the day asked about, with what is in it', async () => {
		show(intentWith('show_calendar', {}), "what's on my calendar tomorrow");

		const widget = widgetNamed('Calendar');
		expect(within(widget).getByText(/^Tomorrow · Thu, Oct 15$/)).toBeTruthy();
		expect(await within(widget).findByText('Focus time')).toBeTruthy();
		expect(within(widget).getByText('1 event')).toBeTruthy();
		expect(fetchMock.mock.calls.some(([input]) => input.startsWith('/api/widgets/events'))).toBe(
			false,
		);
	});

	test('Calendar: when the person is meeting someone, their day with the meeting highlighted, the next a click away', async () => {
		show(intentWith('show_calendar', {meetingWith: ['hugo']}), 'when am i meeting hugo');

		const widget = widgetNamed('Calendar');
		const meeting = await within(widget).findByRole('link', {current: true});
		expect(meeting.textContent).toBe('Hugo / me');
		expect(meeting.getAttribute('href')).toBe('https://calendar.google.com/event?eid=hugo-0');
		expect(within(widget).getByText(/with Hugo Brandt/)).toBeTruthy();
		expect(within(widget).getByText(/^Tue, Oct 20$/)).toBeTruthy();
		// Searched by his name and the address his contact has, from now on.
		const searched = fetchMock.mock.calls.find(([input]) =>
			input.startsWith('/api/widgets/events'),
		);
		const url = new URL(searched?.[0] ?? '', 'http://localhost');
		expect(url.searchParams.getAll('search')).toEqual(['hugo', 'hugo.brandt@example.com']);
		expect(url.searchParams.get('from')).toBe(new Date(2026, 9, 14, 14, 30).toISOString());

		fireEvent.click(
			within(within(widget).getByRole('list', {name: 'Also found'})).getByRole('button'),
		);
		expect(await within(widget).findByText(/^Tue, Oct 27$/)).toBeTruthy();
		expect(within(widget).getByRole('link', {current: true}).getAttribute('href')).toBe(
			'https://calendar.google.com/event?eid=hugo-1',
		);
	});

	test('Calendar: says when nothing is coming up', async () => {
		show(
			intentWith('show_calendar', {eventName: ['dentist']}),
			'when is my next dentist appointment',
		);

		expect(await within(widgetNamed('Calendar')).findByText(/nothing coming up/)).toBeTruthy();
	});

	test('Change event: finds the event, moves it in its own week, adds a guest and sends the update', async () => {
		show(
			intentWith('change_event', {
				changeWith: ['hugo'],
				changeTo: ['thursday at 4'],
				invite: ['jacky'],
			}),
			'move my 1:1 with hugo to thursday at 4 and invite jacky',
		);

		const widget = widgetNamed('Change event');
		expect(await within(widget).findByDisplayValue('Hugo / me')).toBeTruthy();
		// From Tuesday's 3 to 4 to Thursday's 4 to 5, beside Thursday's focus time.
		expect(within(widget).getByText(/^Tue, Oct 20 · 3:00 PM – 4:00 PM$/)).toBeTruthy();
		expect(within(widget).getByText(/Thu, Oct 22 · 4:00 PM – 5:00 PM/)).toBeTruthy();
		expect(await within(widget).findByText('Free then')).toBeTruthy();
		// Two of them coming up, so it says which.
		expect(within(widget).getByRole('combobox', {name: 'Which event'})).toBeTruthy();
		expect(within(widget).getByText('hugo.brandt@example.com')).toBeTruthy();
		expect(await within(widget).findByRole('combobox', {name: 'Which jacky'})).toBeTruthy();

		fireEvent.click(within(widget).getByRole('button', {name: 'Send update'}));
		expect(await within(widget).findByText(/Update sent/)).toBeTruthy();
		const call = fetchMock.mock.calls.find(
			([input, init]) => input === '/api/widgets/events' && init?.method === 'PUT',
		);
		expect(JSON.parse(String(call?.[1]?.body))).toEqual({
			connectionId: 'google-1',
			calendarId: 'me@example.com',
			eventId: 'hugo-0',
			start: new Date(2026, 9, 22, 16).toISOString(),
			end: new Date(2026, 9, 22, 17).toISOString(),
			guests: ['hugo.brandt@example.com', 'jacky.doe@example.com'],
		});
	});

	test('Change event: nothing to save until something changes', async () => {
		show(intentWith('change_event', {changeWith: ['hugo']}), 'change my meeting with hugo');

		const widget = widgetNamed('Change event');
		expect(await within(widget).findByDisplayValue('Hugo / me')).toBeTruthy();
		expect(within(widget).getByRole('button', {name: 'Send update'})).toHaveProperty(
			'disabled',
			true,
		);
		fireEvent.change(within(widget).getByRole('textbox', {name: 'Title'}), {
			target: {value: 'Hugo 1:1'},
		});
		expect(within(widget).getByRole('button', {name: 'Send update'})).toHaveProperty(
			'disabled',
			false,
		);
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

	test('Reply to email: the email found, and the reply sent in its thread from its mailbox', async () => {
		show(
			intentWith('reply_email', {
				from: ['sam'],
				about: ['invoice | bill'],
				body: ['Hi Sam,\n\nPaid this morning.'],
			}),
			"reply to sam's email about the invoice saying it's paid",
		);

		const widget = widgetNamed('Reply to email');
		expect(
			await within(widget).findByText('Sam Lee: Invoice #1042 for September · Oct 11'),
		).toBeTruthy();
		expect(fetchMock).toHaveBeenCalledWith(
			'/api/widgets/emails?from=sam&words=invoice+%7C+bill',
			expect.anything(),
		);
		// What it says, without what it quotes of the email before.
		const email = await within(widget).findByRole('blockquote', {name: 'Email'});
		expect(email.textContent).toContain('Could you let me know once it is paid?');
		expect(email.textContent).not.toContain('wrote:');
		expect(within(widget).getByRole('textbox', {name: 'Reply'})).toHaveProperty(
			'value',
			'Hi Sam,\n\nPaid this morning.',
		);

		await waitFor(() =>
			expect(within(widget).getByRole('button', {name: 'Send'})).toHaveProperty('disabled', false),
		);
		fireEvent.click(within(widget).getByRole('button', {name: 'Send'}));
		expect(await within(widget).findByText('Sent')).toBeTruthy();
		expect(sentTo('/api/widgets/emails/reply')).toEqual({
			connectionId: 'google-1',
			emailId: 'm1',
			body: 'Hi Sam,\n\nPaid this morning.',
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

	test('Ask: the meeting with the person on the day said, what it says, and the others to choose from', async () => {
		show(
			intentWith('ask', {askIn: ['meetings'], askWith: ['hugo']}),
			'what did I talk to hugo about yesterday',
		);
		const widget = widgetNamed('Ask');
		expect(
			await within(widget).findByText('You talked with Hugo about hiring, in Hugo / me.'),
		).toBeTruthy();
		expect(within(widget).getByText('“We should hire two more engineers.”')).toBeTruthy();
		expect(fetchMock).toHaveBeenCalledWith(
			'/api/widgets/meetings?from=2026-10-13&to=2026-10-13&with=hugo',
			expect.anything(),
		);
		expect(sentTo('/api/widgets/answer')).toEqual({
			question: 'what did I talk to hugo about yesterday',
			connectionId: 'granola-1',
			collectionId: 'notes',
			id: 'm2',
		});
		expect(within(widget).getByRole('combobox', {name: 'Which meeting'}).textContent).toContain(
			'Hugo / me · Oct 13',
		);
		expect(within(widget).getByRole('link', {name: 'Open in Granola'}).getAttribute('href')).toBe(
			'https://notes.granola.ai/d/m2',
		);
	});

	test('Ask: no meeting with the person, over the days it looked at', async () => {
		show(
			intentWith('ask', {askIn: ['meetings'], askWith: ['Dana']}),
			'what did i talk about in the meeting with dana?',
		);
		const widget = widgetNamed('Ask');
		expect(
			await within(widget).findByText('No meeting with Dana in the last 3 months'),
		).toBeTruthy();
		cleanup();

		show(
			intentWith('ask', {askIn: ['meetings'], askWith: ['Dana']}),
			'what did dana and i talk about last week?',
		);
		expect(
			await within(widgetNamed('Ask')).findByText('No meeting with Dana since Oct 7'),
		).toBeTruthy();
	});

	test('Ask: a document in Drive or Notion, those named with the words first, and an answer that it doesn’t say', async () => {
		show(
			intentWith('ask', {askIn: ['documents'], askAbout: ['pricing']}),
			'what does the pricing sheet say about discounts',
		);
		const widget = widgetNamed('Ask');
		expect(await within(widget).findByText('The file doesn’t say; it lists prices.')).toBeTruthy();
		expect(fetchMock).toHaveBeenCalledWith(
			'/api/widgets/files?words=pricing&kind=Spreadsheet',
			expect.anything(),
		);
		expect(fetchMock).toHaveBeenCalledWith(
			'/api/widgets/records?collection=pages&words=pricing',
			expect.anything(),
		);
		const which = within(widget).getByRole('combobox', {name: 'Which document'});
		expect(which.textContent).toContain('Pricing 2026 · Oct 8');
		fireEvent.click(which);
		const options = (await screen.findAllByRole('option')).map((option) => option.textContent);
		expect(options).toEqual([
			'Pricing 2026 · Oct 8',
			'Pricing FAQ · Oct 2',
			'Team handbook · Oct 9',
		]);
		expect(within(widget).getByRole('link', {name: 'Open in Google Drive'})).toBeTruthy();
	});

	test('Ask: an email from the person named, since the day said', async () => {
		show(
			intentWith('ask', {askIn: ['emails'], askWith: ['sam'], askAbout: ['invoice']}),
			'what did sam say in the invoice email last week',
		);
		const widget = widgetNamed('Ask');
		expect(await within(widget).findByText('The emails m1 says so.')).toBeTruthy();
		expect(within(widget).getByText('Sam Lee: Invoice #1042 for September · Oct 11')).toBeTruthy();
		expect(fetchMock).toHaveBeenCalledWith(
			'/api/widgets/emails?from=sam&words=invoice&since=2026-10-07',
			expect.anything(),
		);
		expect(sentTo('/api/widgets/answer')).toMatchObject({collectionId: 'emails', id: 'm1'});
	});

	test('Ask: an issue in Linear, by the words of its title', async () => {
		show(
			intentWith('ask', {askIn: ['issues'], askAbout: ['checkout bug']}),
			"what's the status of the checkout bug",
		);
		const widget = widgetNamed('Ask');
		expect(await within(widget).findByText('The issues ENG-12 says so.')).toBeTruthy();
		expect(within(widget).getByText('Checkout fails on Safari · Oct 13')).toBeTruthy();
		expect(fetchMock).toHaveBeenCalledWith(
			'/api/widgets/records?collection=issues&words=checkout&words=bug',
			expect.anything(),
		);
		expect(within(widget).getByRole('link', {name: 'Open in Linear'})).toBeTruthy();
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

	test('Balances: every account with what it holds or owes, the one asked about standing out', async () => {
		show(intentWith('show_balances', {balanceAccount: ['checking']}));
		const widget = widgetNamed('Balances');
		expect(within(widget).getByText('of checking')).toBeTruthy();
		expect(await within(widget).findByText('Plaid Checking')).toBeTruthy();
		expect(within(widget).getByText('$110.00')).toBeTruthy();
		expect(within(widget).getByText('Checking ••0000 · $100.00 available')).toBeTruthy();
		// The card folds away, until asked for.
		expect(within(widget).queryByText('Plaid Credit Card')).toBeNull();
		fireEvent.click(within(widget).getByRole('button', {name: '1 more account'}));
		expect(within(widget).getByText('Plaid Credit Card')).toBeTruthy();
		expect(within(widget).getByText('owed')).toBeTruthy();
		expect(within(widget).getByText('Credit card ••3333 · $1,590.00 available')).toBeTruthy();
		expect(within(widget).getByLabelText('In all').textContent).toBe(
			'In accounts $110.00 · Owed $410.00',
		);
		cleanup();

		show(intentWith('show_balances', {balanceAccount: ['chase']}));
		expect(
			await within(widgetNamed('Balances')).findByText(
				'No account called “chase”, so every account is shown.',
			),
		).toBeTruthy();
		expect(within(widgetNamed('Balances')).getByText('Plaid Credit Card')).toBeTruthy();
	});

	test('Transactions: the days asked about are read once, and sifted by kind, with the days before beside the total', async () => {
		show(
			intentWith('find_transactions', {category: ['FOOD_AND_DRINK'], flow: ['out']}),
			'how much did I spend on restaurants this month',
		);
		const widget = widgetNamed('Transactions');
		expect(within(widget).getByText('Food and drink · this month')).toBeTruthy();
		expect(await within(widget).findByText('Whole Foods')).toBeTruthy();
		// The kind goes without saying in the rows, once asked for; the account doesn't.
		expect(within(widget).queryByText('Food and drink')).toBeNull();
		expect(within(widget).getByText('Plaid Credit Card ••3333')).toBeTruthy();
		// September 17 to October 14: this month and the 14 days before it, in one read.
		expect(fetchMock).toHaveBeenCalledWith(
			'/api/widgets/transactions?from=2026-09-17&to=2026-10-14',
			expect.anything(),
		);
		expect(within(widget).getByLabelText('In all').textContent).toBe(
			'$82.151 transaction · Oct 1 – Oct 14 · $64.00 the 14 days before',
		);
		expect(within(widget).queryByText('Uber')).toBeNull();
		expect(within(widget).queryByText('Netflix')).toBeNull();
	});

	test('Transactions: a merchant by name, money in, and an account, the default days said as missing', async () => {
		show(intentWith('find_transactions', {merchant: ['uber']}), 'find the uber charge');
		const widget = widgetNamed('Transactions');
		expect(within(widget).getByText('the last 30 days')).toBeTruthy();
		expect(await within(widget).findByText('Uber')).toBeTruthy();
		// September's Uber is before the 30 days, and beside the total.
		expect(within(widget).getByLabelText('In all').textContent).toBe(
			'$5.401 transaction · Sep 15 – Oct 14 · $12.80 the 30 days before',
		);
		cleanup();

		show(intentWith('find_transactions', {flow: ['in']}), 'when did I last get paid');
		expect(await within(widgetNamed('Transactions')).findByText(/ACME PAYROLL/)).toBeTruthy();
		expect(within(widgetNamed('Transactions')).getByText('+$2,500.00')).toBeTruthy();
		expect(within(widgetNamed('Transactions')).getByText('· pending')).toBeTruthy();
		cleanup();

		show(
			intentWith('find_transactions', {transactionAccount: ['card']}),
			'what did I spend on my card in october',
		);
		const onCard = widgetNamed('Transactions');
		expect(await within(onCard).findByText('Netflix')).toBeTruthy();
		expect(within(onCard).getByText('Plaid Credit Card ••3333 · October')).toBeTruthy();
		expect(within(onCard).getByText('Entertainment')).toBeTruthy();
		expect(within(onCard).queryByText('Uber')).toBeNull();
		cleanup();

		// A merchant no transaction has beside a kind is that kind said twice.
		show(
			intentWith('find_transactions', {merchant: ['groceries'], category: ['FOOD_AND_DRINK']}),
			'how much did I spend on groceries this month',
		);
		expect(await within(widgetNamed('Transactions')).findByText('Whole Foods')).toBeTruthy();
		expect(
			within(widgetNamed('Transactions')).getByText('Food and drink · this month'),
		).toBeTruthy();
		cleanup();

		// A merchant the model took an account for is the account.
		show(
			intentWith('find_transactions', {merchant: ['credit card']}),
			'what did I spend on my credit card in october',
		);
		expect(await within(widgetNamed('Transactions')).findByText('Netflix')).toBeTruthy();
		expect(
			within(widgetNamed('Transactions')).getByText('Plaid Credit Card ••3333 · October'),
		).toBeTruthy();
	});

	test('Balances and Transactions ask for a bank when none is connected', async () => {
		fetchMock.mockImplementation(() =>
			Promise.resolve(
				Response.json({sources: [], accounts: [], transactions: [], more: false, failed: []}),
			),
		);
		show(intentWith('show_balances', {}));
		expect(
			await screen.findByText('Connect a bank to see your balances and spending from here.'),
		).toBeTruthy();
		expect(screen.getByRole('link', {name: /Connect Plaid/}).getAttribute('href')).toBe(
			'/connections/new/plaid',
		);
		cleanup();

		show(intentWith('find_transactions', {merchant: ['uber']}), 'uber');
		expect(
			await screen.findByText('Connect a bank to see your balances and spending from here.'),
		).toBeTruthy();
	});

	test('shows nothing when no widget fits', () => {
		const {container} = show(intentWith('none', {}));
		expect(container.innerHTML).toBe('');
	});
});
