import {INFO_INTEGRATION_ID} from '@proxy/integrations';
import {newId} from '@/lib/credentials';
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

type Samples = Record<string, Record<string, string>[]>;

// The account a mock connection is made with, standing in for the provider's sign-in.
export const SAMPLE_ACCOUNTS: Record<string, string> = {
	email: 'alex.weber@gmail.com',
};

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
	email: {
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

export function initialState(): MockState {
	const connections: Connection[] = [
		{
			id: INFO_CONNECTION_ID,
			integrationId: INFO_INTEGRATION_ID,
			account: 'Stored in Proxy',
			connectedAt: ago(30 * DAY),
		},
		{
			id: 'email',
			integrationId: 'email',
			account: 'alex.weber@gmail.com',
			connectedAt: ago(21 * DAY),
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
				[grantKey('email', 'emails')]: 'read',
				[grantKey('email', 'drafts')]: 'write',
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
				[grantKey('email', 'emails')]: 'read',
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
			grants: {},
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
		entry(20 * MINUTE, 'inbox', 'email', 'drafts', 'create', 'Re: Thursday sync moved?'),
		entry(22 * MINUTE, 'inbox', 'email', 'emails', 'view', 'Thursday sync moved?'),
		entry(23 * MINUTE, 'inbox', 'email', 'emails', 'list'),
		entry(3 * HOUR, 'shopping', INFO_CONNECTION_ID, 'cards', 'view', 'Personal Visa'),
		entry(3 * HOUR + 2 * MINUTE, 'shopping', INFO_CONNECTION_ID, 'addresses', 'view', 'Home'),
		entry(3 * HOUR + 3 * MINUTE, 'shopping', INFO_CONNECTION_ID, 'addresses', 'list'),
		entry(DAY + 5 * MINUTE, 'inbox', 'email', 'emails', 'list'),
	];

	return {connections, records, agents, audit};
}
