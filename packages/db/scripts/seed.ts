// `bun run seed`: fills the local database with a demo workspace, signed in as demo@proxy.local,
// for looking at the app with data in it. Run it while `bun run dev` is up. Running it again
// deletes the demo user and their organization first, then seeds them again.
import {createCipheriv, createHash, randomBytes} from 'node:crypto';

import {
	effectiveActions,
	EMAIL_PROVIDERS,
	findIntegration,
	INFO_INTEGRATION_ID,
	requiredAction,
	type AgentProviderId,
	type Collection,
	type EmailProvider,
} from '@proxy/integrations';

import {db} from '../src';

const DEMO_EMAIL = 'demo@proxy.local';
const ORG_NAME = "Demo's Workspace";
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const now = Date.now();

// It deletes what it finds under the demo email, so never against anything but the local database.
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl || !URL.canParse(databaseUrl) || !LOCAL_HOSTS.has(new URL(databaseUrl).hostname)) {
	console.error('[seed] DATABASE_URL is not the local database; see .env.example.');
	process.exit(1);
}

const encryptionKey = process.env.ENCRYPTION_KEY;
const authSecret = process.env.AUTH_SECRET;
if (!encryptionKey || !authSecret) {
	console.error('[seed] ENCRYPTION_KEY and AUTH_SECRET are needed; see .env.example.');
	process.exit(1);
}
const key = Buffer.from(encryptionKey, 'base64');

// The api's format (`packages/api/src/utils/secret-crypto.ts`), so it can read what is seeded.
function encrypt(plaintext: string): string {
	const iv = randomBytes(12);
	const cipher = createCipheriv('aes-256-gcm', key, iv);
	const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
	const parts = [iv, cipher.getAuthTag(), ciphertext].map((part) => part.toString('base64url'));
	return ['v1', ...parts].join('.');
}

// Deterministic, so the activity log comes out the same on every run.
let randomState = 42;
function random(): number {
	randomState = (randomState * 1664525 + 1013904223) % 2 ** 32;
	return randomState / 2 ** 32;
}

function pick<T>(items: readonly [T, ...T[]]): T {
	return items[Math.floor(random() * items.length)] ?? items[0];
}

function daysAgo(days: number): Date {
	return new Date(now - days * DAY);
}

// ---- Wipe -----------------------------------------------------------------------------------

const existing = await db.user.findUnique({where: {email: DEMO_EMAIL}, select: {id: true}});
if (existing) {
	const orgs = await db.organization.findMany({
		where: {members: {some: {userId: existing.id}}},
		select: {id: true},
	});
	const orgIds = orgs.map((org) => org.id);
	await db.auditEntry.deleteMany({where: {orgId: {in: orgIds}}});
	await db.organization.deleteMany({where: {id: {in: orgIds}}});
	await db.user.delete({where: {id: existing.id}});
}

// ---- User and organization ------------------------------------------------------------------

const user = await db.user.create({
	data: {email: DEMO_EMAIL, name: 'Demo User', emailVerified: new Date(), createdAt: daysAgo(40)},
});
const org = await db.organization.create({
	data: {name: ORG_NAME, slug: 'demo-workspace', createdAt: daysAgo(40)},
});
await db.orgMember.create({data: {orgId: org.id, userId: user.id}});

// ---- Connections and their defaults ---------------------------------------------------------

type Connection = {id: string; integrationId: string; createdAt: Date};

async function connect(data: {
	integrationId: string;
	account: string;
	credential: string | null;
	daysAgo: number;
	// The actions agents get by default.
	defaults: string[];
}): Promise<Connection> {
	const connection = await db.connection.create({
		data: {
			orgId: org.id,
			integrationId: data.integrationId,
			account: data.account,
			credential: data.credential,
			createdAt: daysAgo(data.daysAgo),
		},
	});
	for (const actionId of data.defaults) {
		await db.connectionDefault.create({data: {connectionId: connection.id, actionId}});
	}
	return connection;
}

// A provider's real servers with a made-up app password: the access pages work, opening the
// mailbox's email fails to sign in.
function mailboxCredential(providerId: EmailProvider['id'], username: string): string {
	const servers = EMAIL_PROVIDERS.find((provider) => provider.id === providerId)?.servers;
	return encrypt(JSON.stringify({...servers, username, password: 'abcd-efgh-ijkl-mnop'}));
}

async function connectMailbox(
	providerId: EmailProvider['id'],
	account: string,
	data: {daysAgo: number; defaults: string[]},
): Promise<Connection> {
	const credential = mailboxCredential(providerId, account);
	return connect({integrationId: 'email', account, credential, ...data});
}

const info = await connect({
	integrationId: INFO_INTEGRATION_ID,
	account: ORG_NAME,
	credential: null,
	daysAgo: 40,
	defaults: ['readAddresses', 'readNotes'],
});
const personal = await connectMailbox('gmail', 'demo.user@gmail.com', {
	daysAgo: 38,
	// Triage and drafts, but nothing goes out.
	defaults: ['read', 'mark', 'flag', 'archive', 'write'],
});
const work = await connectMailbox('fastmail', 'demo@acme-corp.com', {
	daysAgo: 30,
	defaults: ['read'],
});
// No defaults: closed to every agent without a setting of its own.
const receipts = await connectMailbox('icloud', 'demo.receipts@icloud.com', {
	daysAgo: 21,
	defaults: [],
});
const newsletters = await connectMailbox('yahoo', 'demo.news@yahoo.com', {
	daysAgo: 3,
	defaults: ['read', 'mark'],
});

// Made-up tokens, like the mailboxes' passwords: opening a note fails.
const meetings = await connect({
	integrationId: 'granola',
	account: 'demo@acme-corp.com',
	credential: encrypt(
		JSON.stringify({
			clientId: 'demo-client',
			accessToken: 'demo-access-token',
			refreshToken: null,
			expiresAt: null,
		}),
	),
	daysAgo: 10,
	defaults: ['readNotes', 'readTranscripts'],
});

// Made-up tokens, like Granola's: opening a page fails.
const wiki = await connect({
	integrationId: 'notion',
	account: 'demo@acme-corp.com · Acme',
	credential: encrypt(
		JSON.stringify({
			clientId: 'demo-client',
			accessToken: 'demo-access-token',
			refreshToken: null,
			expiresAt: null,
		}),
	),
	daysAgo: 5,
	defaults: ['read'],
});

const connections: [Connection, ...Connection[]] = [
	info,
	personal,
	work,
	receipts,
	newsletters,
	meetings,
	wiki,
];

// ---- Information records --------------------------------------------------------------------

const INFO_RECORDS: Record<string, Array<Record<string, string>>> = {
	addresses: [
		{
			label: 'Home',
			name: 'Demo User',
			street: '221B Baker Street',
			postalCode: 'NW1 6XE',
			city: 'London',
			country: 'United Kingdom',
		},
		{
			label: 'Office',
			name: 'Demo User, Acme Corp',
			street: '1 Market Street, Floor 12',
			postalCode: '94105',
			city: 'San Francisco',
			country: 'United States',
		},
		{
			label: "Parents' place",
			name: 'Demo User',
			street: 'Hauptstraße 5',
			postalCode: '10115',
			city: 'Berlin',
			country: 'Germany',
		},
	],
	cards: [
		{label: 'Personal Visa', cardholder: 'DEMO USER', number: '4242424242424242', expiry: '08/28'},
		{label: 'Work Amex', cardholder: 'DEMO USER', number: '378282246310005', expiry: '11/27'},
	],
	notes: [
		{title: 'Clothing sizes', body: 'Shirts: M\nTrousers: 32/32\nShoes: EU 43 / US 10'},
		{
			title: 'Frequent flyer numbers',
			body: 'Lufthansa Miles & More: 992000123456789\nUnited MileagePlus: AB123456',
		},
		{
			title: 'Dietary preferences',
			body: 'Vegetarian. No peanuts (allergy). Prefers aisle seats on flights.',
		},
		{title: 'Gift ideas', body: 'Mum: gardening gloves, good secateurs\nSam: the new Murakami'},
	],
};

for (const [collectionId, records] of Object.entries(INFO_RECORDS)) {
	for (const values of records) {
		await db.infoRecord.create({
			data: {connectionId: info.id, collectionId, values: encrypt(JSON.stringify(values))},
		});
	}
}

// ---- Agents and their own settings ----------------------------------------------------------

type Grant = {connectionId: string; actionId: string; allowed: boolean};

// The agent's own settings for some actions of a connection, on or off.
function grant(connection: Connection, actions: Record<string, boolean>): Grant[] {
	return Object.entries(actions).map(([actionId, allowed]) => ({
		connectionId: connection.id,
		actionId,
		allowed,
	}));
}

// Every demo agent signs in with this password at /agent/login.
const AGENT_PASSWORD = 'demo-password';
const passwordHash = await Bun.password.hash(AGENT_PASSWORD);

// One login per provider, as the app allows.
async function makeAgent(data: {
	providerId: AgentProviderId;
	name: string;
	username: string;
	daysAgo: number;
	revokedDaysAgo?: number;
	grants: Grant[][];
}) {
	const agent = await db.agent.create({
		data: {
			orgId: org.id,
			providerId: data.providerId,
			name: data.name,
			username: data.username,
			passwordHash,
			createdAt: daysAgo(data.daysAgo),
			revokedAt: data.revokedDaysAgo === undefined ? null : daysAgo(data.revokedDaysAgo),
		},
	});
	const grants = data.grants.flat();
	for (const stored of grants) {
		await db.agentGrant.create({data: {agentId: agent.id, ...stored}});
	}
	return {...agent, grants};
}

const agents = [
	// A setting of its own on every connection, sending included.
	await makeAgent({
		providerId: 'dot',
		name: 'Dots',
		username: 'dots-k7q2',
		daysAgo: 35,
		grants: [
			grant(info, {writeAddresses: true, readCards: true, writeNotes: true}),
			grant(personal, {send: true}),
			grant(work, {write: true, send: true}),
			grant(receipts, {read: true}),
			grant(newsletters, {read: false}),
		],
	}),
	// Reads the cards no agent gets by default and files receipts; kept out of the work mailbox.
	await makeAgent({
		providerId: 'instinct',
		name: 'Instinct',
		username: 'instinct-m3x9',
		daysAgo: 28,
		grants: [
			grant(info, {readCards: true}),
			grant(personal, {write: false}),
			grant(work, {read: false}),
			grant(receipts, {read: true, archive: true}),
		],
	}),
	// Sends status emails from the work address without reading the mailbox.
	await makeAgent({
		providerId: 'grok-bot',
		name: 'Grok Bot',
		username: 'grok-bot-h6fa',
		daysAgo: 20,
		grants: [grant(work, {read: false, send: true})],
	}),
	// Cleans up inboxes, Trash included, but writes nothing.
	await makeAgent({
		providerId: 'muse',
		name: 'Muse',
		username: 'muse-w8hd',
		daysAgo: 14,
		grants: [
			grant(personal, {trash: true, write: false}),
			grant(work, {mark: true, flag: true, archive: true}),
			grant(info, {readAddresses: false, readNotes: false}),
			grant(meetings, {readTranscripts: false}),
			grant(wiki, {read: false}),
		],
	}),
];

// ---- Activity -------------------------------------------------------------------------------

const connectionDefaults = await db.connectionDefault.findMany({
	where: {connectionId: {in: connections.map((connection) => connection.id)}},
});

// What agents ask a collection for: mostly reading, then whatever else it offers.
function requestsOf(collection: Collection): [string, ...string[]] {
	return [
		'list',
		'list',
		'view',
		'view',
		'view',
		...Object.keys(collection.writes),
		...(collection.commands ?? []).map((command) => command.id),
	];
}

// Titles for the mailboxes' emails; Information's come from the records seeded above.
const EMAIL_TITLES: [string, ...string[]] = [
	'Your order has shipped',
	'Q3 planning — agenda',
	'Flight confirmation LH 401',
	'Invoice #20931',
	'Re: dinner on Friday?',
	'Weekly digest',
	'Booking request for 12 Oct',
	'Return request for order 112-883',
	'Thanks for the intro!',
];

// Titles for Granola's meetings.
const MEETING_TITLES: [string, ...string[]] = [
	'Q3 planning',
	'Weekly sync',
	'Design review: onboarding',
	'1:1 with Sam',
	'Customer call — Northwind',
];

// Titles for Notion's pages.
const PAGE_TITLES: [string, ...string[]] = [
	'Roadmap 2027',
	'Onboarding checklist',
	'Hiring plan',
	'Acme GmbH',
	'Team offsite notes',
];

// What agents search for.
const SEARCHES: [string, ...string[]] = [
	'invoice',
	'flight',
	'from:sam',
	'Q3 planning',
	'Home',
	'order',
];

function recordTitle(connection: Connection, collectionId: string): string {
	if (connection.integrationId === 'email') {
		return pick(EMAIL_TITLES);
	}

	if (connection.integrationId === 'granola') {
		return pick(MEETING_TITLES);
	}

	if (connection.integrationId === 'notion') {
		return pick(PAGE_TITLES);
	}

	const titles = (INFO_RECORDS[collectionId] ?? []).map((values) => values.label ?? values.title);
	return titles[Math.floor(random() * titles.length)] ?? 'Untitled';
}

type Request = {connection: Connection; collection: Collection; action: string};

function randomRequest(): Request | null {
	const connection = pick(connections);
	const collections = findIntegration(connection.integrationId)?.collections ?? [];
	const collection = collections[Math.floor(random() * collections.length)];
	if (!collection) {
		return null;
	}

	return {connection, collection, action: pick(requestsOf(collection))};
}

// Allowed or denied by the agent's real access, the way the api decides.
function isAllowed(agent: (typeof agents)[number], request: Request): boolean {
	const {connection, collection, action} = request;
	const integration = findIntegration(connection.integrationId);
	const defaults = connectionDefaults
		.filter((stored) => stored.connectionId === connection.id)
		.map((stored) => stored.actionId);
	const own = Object.fromEntries(
		agent.grants
			.filter((stored) => stored.connectionId === connection.id)
			.map((stored) => [stored.actionId, stored.allowed]),
	);
	const needed = requiredAction(collection, action);
	return (
		integration !== undefined &&
		needed !== null &&
		effectiveActions(integration, defaults, own).includes(needed)
	);
}

let entryCount = 0;
for (const agent of agents) {
	const start = agent.createdAt.getTime();
	const end = agent.revokedAt?.getTime() ?? now;
	const count = agent.grants.length === 0 ? 12 : 25 + Math.floor(random() * 20);
	let lastActiveAt = start;

	for (let i = 0; i < count; i++) {
		const request = randomRequest();
		if (!request) {
			continue;
		}

		const createdAt = start + random() * (end - start);
		lastActiveAt = Math.max(lastActiveAt, createdAt);
		const onOneRecord = request.action !== 'list' && request.action !== 'create';
		const collectionId = request.collection.id;
		// A third of the lists are searches, where the collection can be searched.
		const searched =
			request.action === 'list' && request.collection.searchHint !== undefined && random() < 0.33;
		await db.auditEntry.create({
			data: {
				orgId: org.id,
				agentId: agent.id,
				connectionId: request.connection.id,
				collectionId,
				action: request.action,
				recordTitle: onOneRecord ? recordTitle(request.connection, collectionId) : null,
				query: searched ? pick(SEARCHES) : null,
				outcome: isAllowed(agent, request) ? 'allowed' : 'denied',
				createdAt: new Date(createdAt),
			},
		});
		entryCount += 1;
	}

	await db.agent.update({where: {id: agent.id}, data: {lastActiveAt: new Date(lastActiveAt)}});
}

// ---- A sign-in link -------------------------------------------------------------------------

// A magic link as the api makes one (`packages/api/src/auth/email.ts`): only the token's hash is
// stored, and it works once.
const token = randomBytes(32).toString('hex');
await db.verificationToken.create({
	data: {
		identifier: DEMO_EMAIL,
		token: createHash('sha256').update(`${token}${authSecret}`).digest('hex'),
		expires: new Date(now + DAY),
	},
});
const apiUrl = process.env.VITE_PROXY_API_URL ?? 'http://localhost:4000';
const query = new URLSearchParams({token, email: DEMO_EMAIL, callbackUrl: '/agents'});

console.log(
	`[seed] ${connections.length} connections, ${agents.length} agents and ${entryCount} activity entries for ${DEMO_EMAIL}.`,
);
console.log(`[seed] Sign in, once, within 24 hours: ${apiUrl}/auth/email/verify?${query}`);
console.log(`[seed] Later, ask for a magic link for ${DEMO_EMAIL}; the api prints it.`);
console.log(`[seed] Agents sign in at /agent/login with their username and "${AGENT_PASSWORD}".`);
await db.$disconnect();
