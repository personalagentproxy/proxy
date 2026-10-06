import {newId} from '@/lib/credentials';
import {INFO_INTEGRATION_ID} from '@/lib/integrations';
import type {AgentLogin, AuditEntry, Connection, DataRecord} from '@/lib/types';

export type MockState = {
	connections: Connection[];
	records: DataRecord[];
	agents: AgentLogin[];
	audit: AuditEntry[];
};

export const INFO_CONNECTION_ID = 'info';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function ago(ms: number): string {
	return new Date(Date.now() - ms).toISOString();
}

// What a datetime-local input holds: local time to the minute.
function localDateTime(offset: number): string {
	const date = new Date(Date.now() + offset);
	const pad = (value: number) => value.toString().padStart(2, '0');
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function localDate(offset: number): string {
	return localDateTime(offset).slice(0, 10);
}

type Samples = Record<string, Record<string, string>[]>;

// What each provider would hand back once connected; a new connection starts with these.
export const SAMPLE_RECORDS: Record<string, Samples> = {
	[INFO_INTEGRATION_ID]: {
		addresses: [
			{
				label: 'Home',
				name: 'Alex Weber',
				street: 'Oranienstraße 24',
				postalCode: '10999',
				city: 'Berlin',
				country: 'Germany',
			},
			{
				label: 'Office',
				name: 'Alex Weber',
				street: 'Torstraße 109',
				postalCode: '10119',
				city: 'Berlin',
				country: 'Germany',
			},
		],
		cards: [
			{
				label: 'Personal Visa',
				cardholder: 'Alex Weber',
				number: '4242 4242 4242 4242',
				expiry: '08/28',
			},
		],
		notes: [
			{
				title: 'Clothing sizes',
				body: 'Shirts: M\nJeans: 32/32\nShoes: EU 43',
			},
			{
				title: 'Dietary preferences',
				body: 'Vegetarian. No mushrooms.',
			},
		],
	},
	google: {
		emails: [
			{
				from: 'billing@hetzner.com',
				to: 'alex.weber@gmail.com',
				subject: 'Your invoice for September',
				receivedAt: localDateTime(-2 * HOUR),
				body: 'Hello,\n\nyour invoice for September is ready. The amount of €23.80 will be charged on October 8.\n\nHetzner Online',
			},
			{
				from: 'lena@northwind.dev',
				to: 'alex.weber@gmail.com',
				subject: 'Thursday sync moved?',
				receivedAt: localDateTime(-5 * HOUR),
				body: 'Hey, can we move Thursday to 3pm? I have a conflict at 11.\n\nLena',
			},
			{
				from: 'no-reply@deutschebahn.com',
				to: 'alex.weber@gmail.com',
				subject: 'Booking confirmation: Berlin → Munich',
				receivedAt: localDateTime(-DAY),
				body: 'ICE 1007, departing Berlin Hbf 08:34, arriving München Hbf 12:41. Seat 52, car 7.',
			},
			{
				from: 'newsletter@producthunt.com',
				to: 'alex.weber@gmail.com',
				subject: 'Top products this week',
				receivedAt: localDateTime(-2 * DAY),
				body: 'The five products everyone talked about this week…',
			},
		],
		drafts: [
			{
				to: 'lena@northwind.dev',
				subject: 'Re: Thursday sync moved?',
				body: '3pm works for me.',
			},
		],
		events: [
			{
				title: 'Northwind sync',
				start: localDateTime(2 * DAY),
				end: localDateTime(2 * DAY + HOUR),
				location: 'Google Meet',
				attendees: 'lena@northwind.dev',
				notes: '',
			},
			{
				title: 'Train to Munich',
				start: localDateTime(5 * DAY),
				end: localDateTime(5 * DAY + 4 * HOUR),
				location: 'Berlin Hbf',
				attendees: '',
				notes: 'ICE 1007, car 7, seat 52',
			},
		],
		contacts: [
			{
				name: 'Lena Vogel',
				email: 'lena@northwind.dev',
				phone: '+49 151 2345 6789',
				company: 'Northwind',
			},
			{name: 'Max Bauer', email: 'max.bauer@gmail.com', phone: '+49 170 9876 5432', company: ''},
		],
		files: [
			{
				name: 'Taxes 2025',
				kind: 'Folder',
				folder: 'My Drive',
				modifiedAt: localDateTime(-10 * DAY),
			},
			{
				name: 'Lease agreement.pdf',
				kind: 'PDF',
				folder: 'Home',
				modifiedAt: localDateTime(-40 * DAY),
			},
		],
		docs: [
			{
				title: 'Trip plan: Munich',
				body: 'Day 1: arrive 12:41, check in.\nDay 2: meetings.\nDay 3: back.',
			},
		],
		sheets: [
			{
				title: 'Monthly budget',
				cells: 'Category,Budget,Spent\nGroceries,400,312\nTransport,120,86',
			},
		],
	},
	notion: {
		pages: [
			{
				title: 'Reading list',
				parent: 'Personal',
				body: 'The Pragmatic Programmer\nDesigning Data-Intensive Applications',
			},
			{
				title: 'Proxy ideas',
				parent: 'Projects',
				body: 'Approvals before an agent acts.\nSpending limits per agent.',
			},
		],
		entries: [
			{name: 'Renew passport', database: 'Tasks', status: 'Not started', due: localDate(14 * DAY)},
			{name: 'Book dentist', database: 'Tasks', status: 'Done', due: localDate(-3 * DAY)},
		],
	},
	linear: {
		issues: [
			{
				title: 'Agent sign-in page',
				status: 'In Progress',
				priority: 'High',
				assignee: 'Alex',
				description: 'Username and password, nothing else.',
			},
			{
				title: 'Audit log filters',
				status: 'Todo',
				priority: 'Medium',
				assignee: '',
				description: 'Filter by agent and connection.',
			},
		],
		projects: [
			{name: 'Mock UI', status: 'In progress', lead: 'Alex', targetDate: localDate(10 * DAY)},
		],
	},
};

export function sampleRecords(integrationId: string, connectionId: string): DataRecord[] {
	const samples = SAMPLE_RECORDS[integrationId] ?? {};
	return Object.entries(samples).flatMap(([collectionId, rows]) =>
		rows.map((values) => ({
			id: newId(),
			connectionId,
			collectionId,
			values,
			updatedAt: ago(DAY),
		})),
	);
}

export function grantKey(connectionId: string, collectionId: string): string {
	return `${connectionId}/${collectionId}`;
}

// Google and Notion are connected, Linear is left for the Add connection page to show.
export function initialState(): MockState {
	const connections: Connection[] = [
		{
			id: INFO_CONNECTION_ID,
			integrationId: INFO_INTEGRATION_ID,
			account: 'Stored in Proxy',
			connectedAt: ago(30 * DAY),
		},
		{
			id: 'google',
			integrationId: 'google',
			account: 'alex.weber@gmail.com',
			connectedAt: ago(21 * DAY),
		},
		{
			id: 'notion',
			integrationId: 'notion',
			account: "Alex's workspace",
			connectedAt: ago(12 * DAY),
		},
	];
	const records = connections.flatMap((connection) =>
		sampleRecords(connection.integrationId, connection.id),
	);
	const agents: AgentLogin[] = [
		{
			id: 'inbox',
			name: 'Inbox assistant',
			username: 'inbox-assistant-k7q2',
			password: 'sTx4r-9kPqa-HbN2w-Ue7cZ',
			createdAt: ago(14 * DAY),
			lastActiveAt: ago(20 * MINUTE),
			revokedAt: null,
			grants: {
				[grantKey('google', 'emails')]: 'write',
				[grantKey('google', 'drafts')]: 'write',
				[grantKey('google', 'events')]: 'read',
				[grantKey('google', 'contacts')]: 'read',
				[grantKey('notion', 'pages')]: 'read',
			},
		},
		{
			id: 'shopping',
			name: 'Shopping agent',
			username: 'shopping-agent-m3xd',
			password: 'Lm8vQ-r2TzK-a9WcE-pY4nB',
			createdAt: ago(6 * DAY),
			lastActiveAt: ago(3 * HOUR),
			revokedAt: null,
			grants: {
				[grantKey(INFO_CONNECTION_ID, 'addresses')]: 'read',
				[grantKey(INFO_CONNECTION_ID, 'cards')]: 'read',
				[grantKey(INFO_CONNECTION_ID, 'notes')]: 'read',
				[grantKey('google', 'emails')]: 'read',
			},
		},
		{
			id: 'research',
			name: 'Research agent',
			username: 'research-agent-w5hj',
			password: 'Gq3Nd-x7RbM-k2VfT-zP9sA',
			createdAt: ago(28 * DAY),
			lastActiveAt: ago(11 * DAY),
			revokedAt: ago(10 * DAY),
			grants: {
				[grantKey('notion', 'pages')]: 'write',
				[grantKey('google', 'docs')]: 'read',
			},
		},
	];

	const entry = (
		offset: number,
		agentId: string,
		connectionId: string,
		collectionId: string,
		action: AuditEntry['action'],
		recordTitle: string | null = null,
		outcome: AuditEntry['outcome'] = 'allowed',
	): AuditEntry => ({
		id: newId(),
		at: ago(offset),
		agentId,
		connectionId,
		collectionId,
		action,
		recordTitle,
		outcome,
	});

	const audit: AuditEntry[] = [
		entry(20 * MINUTE, 'inbox', 'google', 'drafts', 'create', 'Re: Thursday sync moved?'),
		entry(21 * MINUTE, 'inbox', 'google', 'events', 'list'),
		entry(22 * MINUTE, 'inbox', 'google', 'emails', 'view', 'Thursday sync moved?'),
		entry(23 * MINUTE, 'inbox', 'google', 'emails', 'list'),
		entry(3 * HOUR, 'shopping', INFO_CONNECTION_ID, 'cards', 'view', 'Personal Visa'),
		entry(3 * HOUR + 2 * MINUTE, 'shopping', INFO_CONNECTION_ID, 'addresses', 'view', 'Home'),
		entry(3 * HOUR + 3 * MINUTE, 'shopping', INFO_CONNECTION_ID, 'addresses', 'list'),
		entry(3 * HOUR + 4 * MINUTE, 'shopping', 'google', 'contacts', 'list', null, 'denied'),
		entry(DAY, 'inbox', 'google', 'emails', 'update', 'Booking confirmation: Berlin → Munich'),
		entry(DAY + 5 * MINUTE, 'inbox', 'google', 'emails', 'list'),
		entry(2 * DAY, 'inbox', 'notion', 'pages', 'view', 'Reading list'),
		entry(2 * DAY + MINUTE, 'inbox', 'notion', 'pages', 'list'),
		entry(11 * DAY, 'research', 'notion', 'pages', 'update', 'Proxy ideas'),
		entry(11 * DAY + 10 * MINUTE, 'research', 'google', 'docs', 'list'),
	];

	return {connections, records, agents, audit};
}
