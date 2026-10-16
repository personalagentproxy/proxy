import {
	useAgenda,
	useEmails,
	useEvents,
	useFiles,
	useMailboxes,
	usePeople,
	useRates,
} from '@/lib/widget-lookups';

// A fake of the home page widgets' api (`/api/widgets/…`) for the web app's tests: one Google
// account with contacts, a calendar, mail and files, answering as the api does. `widgetsAnswer`
// answers a widget request, or null for any other.

const google = {
	connectionId: 'google-1',
	integrationId: 'google',
	account: 'me@example.com',
	name: null,
};

const contact = (name: string, jobTitle: string, phone: string) => ({
	origin: 'contacts' as const,
	connectionId: 'google-1',
	id: `c${name.length}${name.charCodeAt(0)}`,
	name,
	emails: [`${name.toLowerCase().replace(' ', '.')}@example.com`],
	phones: [phone],
	company: 'Example',
	jobTitle,
	addresses: [],
	link: `https://contacts.google.com/person/${name.split(' ')[0]?.toLowerCase()}`,
});

export const CONTACTS = [
	contact('Jacky Doe', 'Product Designer', '+1 415 555 0178'),
	contact('Jacky Chen', 'Engineer', '+1 415 555 0100'),
	contact('Hugo Brandt', 'Operations', '+49 30 5557 0123'),
	contact('Paul Mercer', 'Engineering Manager', '+44 20 7946 0321'),
];

function people(url: URL) {
	const names = url.searchParams.getAll('name');
	return {
		sources: [google],
		people: names.map((name) => ({
			name,
			// As Google's search: the names beginning with every word searched for.
			matches: CONTACTS.filter((candidate) =>
				name
					.toLowerCase()
					.split(' ')
					.every((wanted) =>
						candidate.name
							.toLowerCase()
							.split(' ')
							.some((word) => word.startsWith(wanted)),
					),
			),
		})),
		failed: [],
	};
}

// Focus time from 2 to 4 in the afternoon of whatever day is asked for, on the test's clock.
function agenda(url: URL) {
	const day = new Date(url.searchParams.get('from') ?? '');
	const at = (hour: number) => {
		const time = new Date(day);
		time.setHours(hour, 0, 0, 0);
		return time.toISOString();
	};
	return {
		sources: [google],
		calendars: [
			{
				connectionId: 'google-1',
				id: 'me@example.com',
				name: 'me@example.com',
				primary: true,
				writable: true,
				color: null,
			},
			{
				connectionId: 'google-1',
				id: 'team@group.calendar.google.com',
				name: 'Team',
				primary: false,
				writable: true,
				color: null,
			},
		],
		events: [
			{
				connectionId: 'google-1',
				calendarId: 'me@example.com',
				id: 'e1',
				title: 'Focus time',
				start: at(14),
				end: at(16),
				allDay: false,
				link: null,
			},
		],
		target: {connectionId: 'google-1', calendarId: 'me@example.com'},
		failed: [],
	};
}

// Hugo's 1:1, on the Tuesday after the day searched from and the one after, found by his name or
// his address, as Google's search finds guests.
function foundEvents(url: URL) {
	const from = new Date(url.searchParams.get('from') ?? '');
	const searches = url.searchParams.getAll('search');
	const tuesday = (weeks: number, hour: number) => {
		const time = new Date(from);
		time.setDate(time.getDate() + ((9 - time.getDay()) % 7 || 7) + weeks * 7);
		time.setHours(hour, 0, 0, 0);
		return time.toISOString();
	};
	const found = searches.some((search) => /hugo/i.test(search));
	return {
		sources: [google],
		events: found
			? [0, 1].map((weeks) => ({
					connectionId: 'google-1',
					calendarId: 'me@example.com',
					id: `hugo-${weeks}`,
					title: 'Hugo / me',
					start: tuesday(weeks, 15),
					end: tuesday(weeks, 16),
					allDay: false,
					link: `https://calendar.google.com/event?eid=hugo-${weeks}`,
				}))
			: [],
		failed: [],
	};
}

const EMAILS = [
	{
		connectionId: 'google-1',
		id: 'm1',
		from: 'Sam Lee <sam.lee@example.com>',
		subject: 'Invoice #1042 for September',
		date: '2026-10-11T10:00:00.000Z',
		unread: true,
		link: 'https://mail.google.com/mail/?authuser=me%40example.com#all/m1',
	},
];

const FILES = [
	{
		connectionId: 'google-1',
		id: 'f1',
		name: 'Pricing 2026',
		kind: 'Spreadsheet',
		owner: 'Paul Mercer',
		modified: '2026-10-08T09:00:00.000Z',
		link: 'https://docs.google.com/spreadsheets/d/f1',
		matched: 'name',
	},
];

export function widgetsAnswer(input: string, init?: RequestInit): Response | null {
	const url = new URL(input, 'http://localhost');
	if (!url.pathname.startsWith('/api/widgets/')) {
		return null;
	}
	const route = `${init?.method ?? 'GET'} ${url.pathname}`;
	if (route === 'GET /api/widgets/people') {
		return Response.json(people(url));
	}
	if (route === 'GET /api/widgets/agenda') {
		return Response.json(agenda(url));
	}
	if (route === 'GET /api/widgets/events') {
		return Response.json(foundEvents(url));
	}
	if (route === 'POST /api/widgets/events') {
		return Response.json({title: 'Made', link: 'https://calendar.google.com/event?eid=1'});
	}
	if (route === 'GET /api/widgets/emails') {
		return Response.json({sources: [google], emails: EMAILS, failed: []});
	}
	if (route === 'POST /api/widgets/emails') {
		return Response.json({sent: true});
	}
	if (route === 'GET /api/widgets/mailboxes') {
		return Response.json({sources: [google], target: 'google-1'});
	}
	if (route === 'GET /api/widgets/rates') {
		return Response.json({
			date: '2026-10-14',
			rates: {EUR: 1, USD: 1.1195, GBP: 0.84385, JPY: 177.39, CHF: 0.933, CAD: 1.5918},
		});
	}
	if (route === 'GET /api/widgets/files') {
		return Response.json({sources: [google], files: FILES, failed: []});
	}
	return Response.json({error: 'not_found'}, {status: 404});
}

/** Forgets what the widgets read, between tests. */
export function clearWidgetLookups(): void {
	for (const lookup of [
		usePeople,
		useAgenda,
		useEvents,
		useEmails,
		useMailboxes,
		useFiles,
		useRates,
	]) {
		lookup.clear();
	}
}
