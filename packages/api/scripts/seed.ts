// `bun run seed`: fills the local database with a demo workspace, signed in as demo@proxy.local,
// for looking at the app with data in it. Run it while `bun run dev` is up. Running it again
// deletes the demo user and their organization first, then seeds them again. It makes what it
// can as the api does, with the packages' own functions, then dates it back; what agents did,
// their tasks and their requests, it writes as rows of its own, since those functions log what
// happens now, not what happened weeks ago.
import {randomBytes} from 'node:crypto';

import type {Result} from 'ts-results-es';

import {effectiveActions, findIntegration, requiredAction, type Collection} from '@proxy/integrations';
import type {ApiError} from '@proxy/utils';
import type {AgentProviderId} from '@proxy/utils/agent-providers';
import {EMAIL_PROVIDERS, type EmailProvider} from '@proxy/utils/email-providers';
import {hashVerificationToken, secretCipher} from '@proxy/utils/secret-crypto';
import {db, disconnectDb} from '@proxy/db';
import {createAgent, setAgentGrants} from '@proxy/db/agent';
import {createVerificationToken} from '@proxy/db/auth';
import {createConnection, listOrgConnectionsWithCredential} from '@proxy/db/connection';
import {provisionOrganization} from '@proxy/db/organization';
import {deleteUser} from '@proxy/db/user';
import {createVaultEntry} from '@proxy/db/vault';

import {ORGANIZATION_CONNECTIONS} from '../src/orgs/starter-connections';

// Whose workspace it is: the demo person's, or with SEED_EMAIL another's, such as the dev user's
// (`dev@dev.proxy.local`), whom the login page signs in as in development.
const DEMO_EMAIL = process.env.SEED_EMAIL || 'demo@proxy.local';
const WORKSPACE_SLUG = `${DEMO_EMAIL.split('@')[0]}-workspace`;
// Agent usernames are unique across workspaces, so another person's get their name on the end.
const USERNAME_SUFFIX = DEMO_EMAIL === 'demo@proxy.local' ? '' : `-${DEMO_EMAIL.split('@')[0]}`;
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
// The api's cipher, under its key, so it can read what is seeded.
const cipher = secretCipher(Buffer.from(encryptionKey, 'base64'));

function encrypt(plaintext: string): string {
	return cipher.encrypt(plaintext);
}

// What a package's function answered; the seed stops at the first that failed.
function must<T>(result: Result<T, ApiError>): T {
	if (result.isErr()) {
		console.error('[seed] Failed:', result.error);
		process.exit(1);
	}
	return result.value;
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
	// The organizations the demo user owns: one they were invited into is someone else's. Their
	// activity goes first, as it always has; the rest goes with the user, as deleting an account
	// takes it.
	const orgs = await db.organization.findMany({
		where: {ownerUserId: existing.id},
		select: {id: true},
	});
	const orgIds = orgs.map((org) => org.id);
	await db.auditEntry.deleteMany({where: {orgId: {in: orgIds}}});
	await db.agentTask.deleteMany({where: {orgId: {in: orgIds}}});
	must(await deleteUser(existing.id));
}

// ---- User and organization ------------------------------------------------------------------

// Made as a sign-up makes them, the organization with its vaults, then dated back.
const provisioned = must(
	await provisionOrganization({
		owner: {
			user: {email: DEMO_EMAIL, name: 'Demo User', emailVerified: new Date(), createdAt: daysAgo(40)},
		},
		name: ORG_NAME,
		slugSource: WORKSPACE_SLUG,
		onboardedAt: daysAgo(40),
		connections: ORGANIZATION_CONNECTIONS,
	}),
);
const org = provisioned.org;
const user = {id: provisioned.ownerUserId};
await db.organization.update({where: {id: org.id}, data: {createdAt: daysAgo(40)}});

// ---- Connections and their defaults ---------------------------------------------------------

type Connection = {id: string; integrationId: string; defaults: string[]};

// A connection as the api makes one, the demo user's own, as everything in an organization with
// one member is, connected `daysAgo`.
async function connect(data: {
	integrationId: string;
	account: string;
	credential: string;
	daysAgo: number;
	// The actions agents get by default.
	defaults: string[];
}): Promise<Connection> {
	const connection = must(
		await createConnection({
			orgId: org.id,
			ownerUserId: user.id,
			connectedById: user.id,
			integrationId: data.integrationId,
			account: data.account,
			credential: data.credential,
			defaults: data.defaults,
		}),
	);
	await db.connection.update({where: {id: connection.id}, data: {createdAt: daysAgo(data.daysAgo)}});
	return {id: connection.id, integrationId: connection.integrationId, defaults: data.defaults};
}

// A provider's real servers with a made-up app password: the access pages work, opening the
// mailbox's email fails to sign in.
function mailboxCredential(providerId: EmailProvider['id'], username: string): string {
	const servers = EMAIL_PROVIDERS.find((provider) => provider.id === providerId)?.servers;
	return encrypt(JSON.stringify({...servers, username, password: 'abcd-efgh-ijkl-mnop'}));
}

async function connectMailbox(providerId: EmailProvider['id'], account: string, data: {daysAgo: number; defaults: string[]}): Promise<Connection> {
	const credential = mailboxCredential(providerId, account);
	return connect({integrationId: 'email', account, credential, ...data});
}

// The demo user's own vault and the organization's, made with it.
const vaults = must(await listOrgConnectionsWithCredential(org.id));
for (const made of vaults) {
	await db.connection.update({where: {id: made.id}, data: {createdAt: daysAgo(40)}});
}
const ownVault = vaults.find((made) => made.ownerUserId === user.id);
const sharedVault = vaults.find((made) => made.ownerUserId === null);
if (!ownVault || !sharedVault) {
	console.error('[seed] The organization was made without its vaults.');
	process.exit(1);
}
const vault: Connection = {
	id: ownVault.id,
	integrationId: ownVault.integrationId,
	defaults: ownVault.defaults.map((stored) => stored.actionId),
};
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

// Made-up tokens, like Notion's: opening an issue fails.
const tracker = await connect({
	integrationId: 'linear',
	account: 'demo@acme-corp.com · Acme',
	credential: encrypt(
		JSON.stringify({
			clientId: 'demo-client',
			accessToken: 'demo-access-token',
			refreshToken: null,
			expiresAt: null,
		}),
	),
	daysAgo: 2,
	defaults: ['read', 'create'],
});

// Made-up tokens, like Linear's: opening a file, an email, an event or a contact fails.
const googleAccount = await connect({
	integrationId: 'google',
	account: 'demo.user@gmail.com',
	credential: encrypt(
		JSON.stringify({
			accessToken: 'demo-access-token',
			refreshToken: null,
			expiresAt: null,
			scopes: [
				'openid',
				'https://www.googleapis.com/auth/userinfo.email',
				'https://www.googleapis.com/auth/gmail.modify',
				'https://www.googleapis.com/auth/gmail.send',
				'https://www.googleapis.com/auth/calendar.events',
				'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
				'https://www.googleapis.com/auth/calendar.events.freebusy',
				'https://www.googleapis.com/auth/drive',
				'https://www.googleapis.com/auth/contacts',
				'https://www.googleapis.com/auth/contacts.other.readonly',
				'https://www.googleapis.com/auth/tasks',
			],
			email: 'demo.user@gmail.com',
		}),
	),
	daysAgo: 1,
	defaults: ['readEmails', 'readEvents', 'writeEvents', 'readFiles'],
});

const connections: [Connection, ...Connection[]] = [vault, personal, work, receipts, newsletters, meetings, wiki, tracker, googleAccount];

// ---- Vault entries --------------------------------------------------------------------------

const VAULT_ENTRIES: Array<{title: string; type: string; content: string}> = [
	{
		title: 'Home',
		type: 'Address',
		content: 'Demo User\n221B Baker Street\nNW1 6XE London\nUnited Kingdom',
	},
	{
		title: 'Office',
		type: 'Address',
		content: 'Demo User, Acme Corp\n1 Market Street, Floor 12\n94105 San Francisco\nUnited States',
	},
	{title: 'Mobile', type: 'Phone number', content: '+44 20 7946 0958'},
	{title: 'Work email', type: 'Email', content: 'demo@acme-corp.com'},
	{title: 'Personal website', type: 'Link', content: 'https://demo-user.example.com'},
	{title: 'Birthday', type: 'Date', content: '1990-04-12'},
	{
		title: 'Clothing sizes',
		type: 'Text',
		content: 'Shirts: M\nTrousers: 32/32\nShoes: EU 43 / US 10',
	},
	{title: 'Dietary preferences', type: 'Text', content: 'Vegetarian. No peanuts (allergy).'},
	{title: 'Flights', type: 'Text', content: 'Prefers aisle seats, and morning flights.'},
];

// What everyone's agents should know about the organization, in its shared vault.
const SHARED_VAULT_ENTRIES: Array<{title: string; type: string; content: string}> = [
	{
		title: 'Office',
		type: 'Address',
		content: 'Acme Corp\n1 Market Street, Floor 12\n94105 San Francisco\nUnited States',
	},
	{title: 'Support inbox', type: 'Email', content: 'support@acme-corp.com'},
	{
		title: 'How we write',
		type: 'Text',
		content: 'Short sentences. No exclamation marks. Sign off with the team, not a person.',
	},
];

for (const [connectionId, entries] of [
	[vault.id, VAULT_ENTRIES],
	[sharedVault.id, SHARED_VAULT_ENTRIES],
] as const) {
	for (const values of entries) {
		must(await createVaultEntry({connectionId, collectionId: 'entries'}, encrypt(JSON.stringify(values))));
	}
}

// ---- Agents and their own settings ----------------------------------------------------------

type Grant = {connectionId: string; actions: Record<string, boolean>};

// The agent's own settings for some actions of a connection, on or off.
function grant(connection: Connection, actions: Record<string, boolean>): Grant {
	return {connectionId: connection.id, actions};
}

// Every demo agent signs in with this password at /agent/login.
const AGENT_PASSWORD = 'demo-password';
const passwordHash = await Bun.password.hash(AGENT_PASSWORD);

type Agent = {
	id: string;
	createdAt: Date;
	grants: Array<{connectionId: string; actionId: string; allowed: boolean}>;
};

// An agent as the api makes one, the demo user's own, as everything in an organization with one
// member is, made `daysAgo`, with its own settings.
async function makeAgent(data: {providerId: AgentProviderId; name: string; username: string; daysAgo: number; grants: Grant[]}): Promise<Agent> {
	const agent = must(
		await createAgent({
			orgId: org.id,
			ownerUserId: user.id,
			createdById: user.id,
			providerId: data.providerId,
			name: data.name,
			username: `${data.username}${USERNAME_SUFFIX}`,
			passwordHash,
		}),
	);
	const createdAt = daysAgo(data.daysAgo);
	await db.agent.update({where: {id: agent.id}, data: {createdAt}});
	for (const {connectionId, actions} of data.grants) {
		must(await setAgentGrants({agentId: agent.id, connectionId, actions}));
	}
	const grants = data.grants.flatMap(({connectionId, actions}) => Object.entries(actions).map(([actionId, allowed]) => ({connectionId, actionId, allowed})));
	return {id: agent.id, createdAt, grants};
}

const agents = [
	// A setting of its own on every connection, sending included.
	await makeAgent({
		providerId: 'dot',
		name: 'Dots',
		username: 'dots-k7q2',
		daysAgo: 35,
		grants: [
			grant(personal, {send: true}),
			grant(work, {write: true, send: true}),
			grant(receipts, {read: true}),
			grant(newsletters, {read: false}),
			grant(googleAccount, {createFiles: true, editFiles: true}),
		],
	}),
	// A second login of the same company, named by the person: reads, and nothing more.
	await makeAgent({
		providerId: 'dot',
		name: 'Dots research',
		username: 'dots-research-p4tn',
		daysAgo: 30,
		grants: [grant(work, {write: false}), grant(googleAccount, {readEmails: true})],
	}),
	// Files receipts; kept out of the work mailbox.
	await makeAgent({
		providerId: 'instinct',
		name: 'Instinct',
		username: 'instinct-m3x9',
		daysAgo: 28,
		grants: [grant(personal, {write: false}), grant(work, {read: false}), grant(receipts, {read: true, archive: true})],
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
			grant(googleAccount, {readEmails: true, markEmails: true, archiveEmails: true}),
			grant(vault, {readEntries: false}),
			grant(meetings, {readTranscripts: false}),
			grant(wiki, {read: false}),
			grant(tracker, {create: false}),
		],
	}),
];

// ---- Activity -------------------------------------------------------------------------------

// What agents ask a collection for: mostly reading, then whatever else it offers.
function requestsOf(collection: Collection): [string, ...string[]] {
	return ['list', 'list', 'view', 'view', 'view', ...Object.keys(collection.writes), ...(collection.commands ?? []).map((command) => command.id)];
}

// Titles for the mailboxes' emails, and Gmail's; the vault's come from the entries seeded above.
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
const MEETING_TITLES: [string, ...string[]] = ['Q3 planning', 'Weekly sync', 'Design review: onboarding', '1:1 with Sam', 'Customer call — Northwind'];

// Titles for Notion's pages.
const PAGE_TITLES: [string, ...string[]] = ['Roadmap 2027', 'Onboarding checklist', 'Hiring plan', 'Acme GmbH', 'Team offsite notes'];

// Titles for Linear's issues.
const ISSUE_TITLES: [string, ...string[]] = [
	'Fix the login page on Safari',
	'Onboarding emails go out twice',
	'Add CSV export to reports',
	'Dark mode for the settings page',
	'Slow search on large workspaces',
];

// Titles for Google Drive's files.
const FILE_TITLES: [string, ...string[]] = ['Budget 2027', 'Launch plan', 'Board deck — October', 'Contracts', 'Trip itinerary'];

// The ranges agents read and write in spreadsheets.
const RANGE_TITLES: [string, ...string[]] = ["'Q1 Sales'!A1:F20", 'Budget!B2:B14', "'Trip costs'!A1:D9"];

// The attachments agents read.
const ATTACHMENT_TITLES: [string, ...string[]] = ['Q3 budget.xlsx', 'Invoice 1042.pdf', 'Lease.docx'];

// The replies agents send or save as drafts.
const REPLY_TITLES: [string, ...string[]] = ['Re: Q3 planning — agenda', 'Re: Booking request for 12 Oct', 'Re: Thanks for the intro!'];

// What agents search for.
const SEARCHES: [string, ...string[]] = ['invoice', 'flight', 'from:sam', 'Q3 planning', 'Home', 'order'];

function recordTitle(connection: Connection, collectionId: string): string {
	if (collectionId === 'attachments') {
		return pick(ATTACHMENT_TITLES);
	}

	if (collectionId === 'replies') {
		return pick(REPLY_TITLES);
	}

	if (connection.integrationId === 'email' || collectionId === 'emails') {
		return pick(EMAIL_TITLES);
	}

	if (connection.integrationId === 'granola') {
		return pick(MEETING_TITLES);
	}

	if (connection.integrationId === 'notion') {
		return pick(PAGE_TITLES);
	}

	if (connection.integrationId === 'linear') {
		return pick(ISSUE_TITLES);
	}

	if (collectionId === 'ranges') {
		return pick(RANGE_TITLES);
	}

	if (connection.integrationId === 'google') {
		return pick(FILE_TITLES);
	}

	const titles = VAULT_ENTRIES.map((entry) => entry.title);
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

// A request the agent may make, found by trying; `fallback` when none turns up.
function allowedRequest(agent: Agent, fallback: Request): Request {
	for (let attempt = 0; attempt < 20; attempt++) {
		const candidate = randomRequest();
		if (candidate && isAllowed(agent, candidate)) {
			return candidate;
		}
	}
	return fallback;
}

// Allowed or denied by the agent's real access, the way the api decides.
function isAllowed(agent: Agent, request: Request): boolean {
	const {connection, collection, action} = request;
	const integration = findIntegration(connection.integrationId);
	const {defaults} = connection;
	const own = Object.fromEntries(agent.grants.filter((stored) => stored.connectionId === connection.id).map((stored) => [stored.actionId, stored.allowed]));
	const needed = requiredAction(collection, action);
	return integration !== undefined && needed !== null && effectiveActions(integration, defaults, own).includes(needed);
}

// Now and then the service fails an allowed request: too many requests, out of reach, or the
// connection's sign-in turned down, as the api logs what went wrong.
const FAILURES: [string, ...string[]] = ['provider_unreachable 429', 'provider_unreachable 503', 'provider_unreachable', 'credentials_rejected'];

function outcomeOf(agent: Agent, request: Request): {outcome: 'allowed' | 'denied' | 'failed'; error: string | null} {
	if (!isAllowed(agent, request)) {
		return {outcome: 'denied', error: null};
	}
	if (random() < 0.05) {
		return {outcome: 'failed', error: pick(FAILURES)};
	}
	return {outcome: 'allowed', error: null};
}

// What the agents set out to do: every request is made for a task, as the api logs them, a few
// requests in a row to each.
const TASKS: [{title: string; goal: string}, ...Array<{title: string; goal: string}>] = [
	{
		title: 'Triage this morning’s inbox',
		goal: 'Go through the new emails, archive the newsletters and flag anything that needs an answer today.',
	},
	{
		title: 'Prepare for the Acme call',
		goal: 'Pull the notes from the last meeting with Acme and the open issues, and draft an agenda.',
	},
	{
		title: 'Find the Visa card number',
		goal: 'Look up the personal Visa card to pay the domain renewal.',
	},
	{
		title: 'Plan the week',
		goal: 'List this week’s events and the open issues assigned to me, and suggest what to do first.',
	},
	{
		title: 'Reply to Sam about Q3 planning',
		goal: 'Find Sam’s email about Q3 planning and draft a reply with the dates that work.',
	},
	{
		title: 'Expense report',
		goal: 'Collect the receipts emailed in October and list them with their amounts.',
	},
];

// Parts of a task an agent handed to sub-agents of its own: each a sub-task of it, with what the
// sub-agent handed back once done.
const SUB_TASKS: [{title: string; goal: string; outcome: string}, ...Array<{title: string; goal: string; outcome: string}>] = [
	{
		title: 'Check the calendar',
		goal: 'List this week’s events and when the day is free.',
		outcome: 'Four events this week, Tuesday and Thursday afternoons free.',
	},
	{
		title: 'Find the open issues',
		goal: 'List the open issues assigned to me, the ones due soonest first.',
		outcome: 'Six issues open, two due this week.',
	},
	{
		title: 'Pull the meeting notes',
		goal: 'Find the notes from the last meeting and the decisions in them.',
		outcome: 'Found the notes from last Thursday, three decisions and two open points.',
	},
];

const MINUTE = 60 * 1000;

// How long a request took: most well under a second, a few a good deal longer.
function requestDuration(): number {
	return Math.round(150 + random() ** 3 * 6000);
}
// A login still in use has this many tasks going at once in the past hours, the usual way agents
// work, with this many requests spread over them.
const CONCURRENT_TASKS = 5;
const RECENT_REQUESTS = 14;

let entryCount = 0;
let taskCount = 0;

// One job split among sub-agents as an agent at work splits one, for a task's timeline to show:
// the task, the parts handed on, one handed on again, each with requests a few seconds apart and as
// long as they took, a refusal and a failure among them. Minutes from when the job started.
type JobPart = {
	title: string;
	goal: string;
	outcome: string;
	from: number;
	to: number;
	// Where its requests ran, as minutes from the start, a few seconds apart.
	busy: Array<[number, number]>;
	parts?: JobPart[];
};

const JOB: JobPart = {
	title: 'Prepare the board update',
	goal: 'Gather the quarter’s numbers, what customers said on their calls and what is still open, and draft the board update.',
	outcome: 'Drafted the board update with revenue up 12%, three customer themes and the two issues at risk.',
	from: 0,
	to: 13,
	busy: [
		[0.05, 0.6],
		[7.4, 12.6],
	],
	parts: [
		{
			title: 'Gather the quarter’s numbers',
			goal: 'Collect revenue, churn and new customers for the quarter.',
			outcome: 'Revenue up 12% on last quarter, churn down to 2.1%, 38 new customers.',
			from: 0.7,
			to: 5.6,
			busy: [
				[0.8, 1.1],
				[3.5, 5.4],
			],
			parts: [
				{
					title: 'Pull the revenue sheet',
					goal: 'Find the quarter’s revenue sheet and read the totals.',
					outcome: 'Read the totals from the Q3 revenue sheet.',
					from: 1.2,
					to: 3.3,
					busy: [[1.3, 3.1]],
				},
			],
		},
		{
			title: 'Summarize the customer calls',
			goal: 'Read the notes from this quarter’s customer calls and the themes in them.',
			outcome: 'Three themes: onboarding takes too long, the reports export, and pricing for small teams.',
			from: 0.8,
			to: 7.1,
			busy: [[0.9, 6.9]],
		},
		{
			title: 'Check the open issues',
			goal: 'List the open issues and which of them put the quarter’s goals at risk.',
			outcome: 'Fourteen issues open, two of them at risk of slipping past the quarter.',
			from: 0.9,
			to: 4.2,
			busy: [[1.0, 4.0]],
		},
	],
};

// When the part, or the last of the parts it handed on at any depth, started, in minutes.
function lastStart(part: JobPart): number {
	return Math.max(part.from, ...(part.parts ?? []).map(lastStart));
}

async function seedJob(agent: Agent, startedAt: number): Promise<number> {
	let last = startedAt;
	let refused = false;
	let failed = false;
	const at = (minutes: number) => startedAt + minutes * MINUTE;
	const seedPart = async (part: JobPart, parentId: string | null) => {
		const via = 'mcp' as const;
		const task = await db.agentTask.create({
			data: {
				orgId: org.id,
				ownerUserId: user.id,
				agentId: agent.id,
				parentId,
				title: part.title,
				goal: part.goal,
				via,
				createdAt: new Date(at(part.from)),
				lastActiveAt: new Date(at(lastStart(part))),
				finishedAt: new Date(at(part.to)),
				outcome: part.outcome,
			},
		});
		taskCount += 1;
		for (const [from, to] of part.busy) {
			for (let time = at(from); time < at(to); time += (4 + random() * 14) * 1000) {
				const fallback = randomRequest();
				if (!fallback) {
					continue;
				}
				const picked = allowedRequest(agent, fallback);
				const durationMs = requestDuration();
				const done = time + durationMs;
				// One refusal in the job and one failure, where the agent has something it may not do.
				const refusal = !refused && parentId !== null && random() < 0.08;
				const request = refusal ? (deniedRequest(agent) ?? picked) : picked;
				const outcome = isAllowed(agent, request) ? 'allowed' : 'denied';
				const failure = !failed && outcome === 'allowed' && random() < 0.04;
				refused ||= outcome === 'denied';
				failed ||= failure;
				const onOneRecord = request.action !== 'list' && request.action !== 'create';
				await db.auditEntry.create({
					data: {
						orgId: org.id,
						ownerUserId: user.id,
						agentId: agent.id,
						connectionId: request.connection.id,
						collectionId: request.collection.id,
						action: request.action,
						recordTitle: onOneRecord ? recordTitle(request.connection, request.collection.id) : null,
						query: null,
						outcome: failure ? 'failed' : outcome,
						error: failure ? pick(FAILURES) : null,
						via,
						taskId: task.id,
						durationMs,
						createdAt: new Date(done),
					},
				});
				entryCount += 1;
				last = Math.max(last, done);
				time = done;
			}
		}
		for (const child of part.parts ?? []) {
			await seedPart(child, task.id);
		}
	};
	await seedPart(JOB, null);
	return last;
}

// A request the agent may not make, where there is one.
function deniedRequest(agent: Agent): Request | null {
	for (let attempt = 0; attempt < 40; attempt++) {
		const candidate = randomRequest();
		if (candidate && !isAllowed(agent, candidate)) {
			return candidate;
		}
	}
	return null;
}

let jobSeeded = false;
for (const agent of agents) {
	const start = agent.createdAt.getTime();
	const end = now;
	const count = agent.grants.length === 0 ? 12 : 25 + Math.floor(random() * 20);
	let lastActiveAt = start;

	// The requests in the order they were made, so a task is a run of them.
	const requests = Array.from({length: count}, () => ({
		request: randomRequest(),
		createdAt: start + random() * (end - start),
	}))
		.flatMap(({request, createdAt}) => (request ? [{request, createdAt}] : []))
		.sort((a, b) => a.createdAt - b.createdAt);
	// Every login is still in use, so has several tasks going at once in the past hours, its latest
	// requests spread over them, so the home page's lanes show how agents really work.
	const recent = requests.splice(-RECENT_REQUESTS);
	if (recent.length > 0) {
		const concurrent = await Promise.all(
			Array.from({length: CONCURRENT_TASKS}, async (_, index) => {
				const startedAt = now - (110 - index * 20) * MINUTE - random() * 15 * MINUTE;
				// The first two are done; the rest are under way, with something done for them lately.
				const finishedAt = index < 2 ? startedAt + (25 + random() * 30) * MINUTE : null;
				const lastActiveAt = finishedAt === null ? now - random() * 5 * MINUTE : startedAt;
				const taskVia: 'web' | 'mcp' = random() < 0.7 ? 'mcp' : 'web';
				const task = await db.agentTask.create({
					data: {
						orgId: org.id,
						ownerUserId: user.id,
						agentId: agent.id,
						...pick(TASKS),
						via: taskVia,
						createdAt: new Date(startedAt),
						lastActiveAt: new Date(lastActiveAt),
						finishedAt: finishedAt === null ? null : new Date(finishedAt),
					},
				});
				taskCount += 1;
				return {id: task.id, via: taskVia, startedAt, endsAt: finishedAt ?? now};
			}),
		);
		// The oldest task, done, and the newest, under way, were split among sub-agents: a sub-task
		// each, the done one's with what it handed back.
		const subTasks: typeof concurrent = [];
		for (const parent of [concurrent[0], concurrent.at(-1)].flatMap((task) => (task ? [task] : []))) {
			const parentDone = parent.endsAt !== now;
			let parentActiveAt = parent.startedAt;
			for (const [index, part] of SUB_TASKS.entries()) {
				const startedAt = parent.startedAt + (2 + index * 3 + random() * 2) * MINUTE;
				const finishedAt = parentDone || index === 0 ? startedAt + (4 + random() * 8) * MINUTE : null;
				const lastActiveAt = finishedAt === null ? now - random() * 5 * MINUTE : startedAt;
				const task = await db.agentTask.create({
					data: {
						orgId: org.id,
						ownerUserId: user.id,
						agentId: agent.id,
						parentId: parent.id,
						title: part.title,
						goal: part.goal,
						via: parent.via,
						createdAt: new Date(startedAt),
						lastActiveAt: new Date(lastActiveAt),
						finishedAt: finishedAt === null ? null : new Date(finishedAt),
						outcome: finishedAt === null ? null : part.outcome,
					},
				});
				taskCount += 1;
				subTasks.push({id: task.id, via: parent.via, startedAt, endsAt: finishedAt ?? now});
				parentActiveAt = Math.max(parentActiveAt, lastActiveAt);
			}
			await db.agentTask.updateMany({
				where: {id: parent.id, lastActiveAt: {lt: new Date(parentActiveAt)}},
				data: {lastActiveAt: new Date(parentActiveAt)},
			});
		}
		const pool = [...concurrent, ...subTasks];
		for (const [index, {request: picked}] of recent.entries()) {
			const task = pool[index % pool.length];
			if (!task) {
				continue;
			}
			// Mostly what the login may do: a refusal now and then, not at every turn.
			const request = isAllowed(agent, picked) || random() < 0.2 ? picked : allowedRequest(agent, picked);
			const createdAt = task.startedAt + random() * (task.endsAt - task.startedAt);
			lastActiveAt = Math.max(lastActiveAt, createdAt);
			const onOneRecord = request.action !== 'list' && request.action !== 'create';
			await db.auditEntry.create({
				data: {
					orgId: org.id,
					ownerUserId: user.id,
					agentId: agent.id,
					connectionId: request.connection.id,
					collectionId: request.collection.id,
					action: request.action,
					recordTitle: onOneRecord ? recordTitle(request.connection, request.collection.id) : null,
					query: null,
					...outcomeOf(agent, request),
					via: task.via,
					taskId: task.id,
					durationMs: requestDuration(),
					createdAt: new Date(createdAt),
				},
			});
			entryCount += 1;
		}
	}

	// The first login in use with settings of its own did the job, finished a quarter hour ago.
	if (!jobSeeded && recent.length > 0 && agent.grants.length > 0) {
		jobSeeded = true;
		lastActiveAt = Math.max(lastActiveAt, await seedJob(agent, now - 28 * MINUTE));
	}

	let taskId: string | null = null;
	let via: 'web' | 'mcp' = 'web';
	let leftInTask = 0;
	for (const [index, {request, createdAt}] of requests.entries()) {
		if (leftInTask === 0 || taskId === null) {
			leftInTask = 1 + Math.floor(random() * 4);
			const lastIndex = Math.min(index + leftInTask, requests.length) - 1;
			// Most come in over MCP, as Claude or ChatGPT would; some through the agent pages.
			via = random() < 0.7 ? 'mcp' : 'web';
			const task = await db.agentTask.create({
				data: {
					orgId: org.id,
					ownerUserId: user.id,
					agentId: agent.id,
					...pick(TASKS),
					via,
					createdAt: new Date(createdAt - MINUTE),
					lastActiveAt: new Date(createdAt - MINUTE),
					finishedAt: new Date((requests[lastIndex]?.createdAt ?? createdAt) + MINUTE),
				},
			});
			taskId = task.id;
			taskCount += 1;
		}
		leftInTask -= 1;

		lastActiveAt = Math.max(lastActiveAt, createdAt);
		const onOneRecord = request.action !== 'list' && request.action !== 'create';
		const collectionId = request.collection.id;
		// A third of the lists are searches, where the collection can be searched.
		const searched = request.action === 'list' && request.collection.searchHint !== undefined && random() < 0.33;
		await db.auditEntry.create({
			data: {
				orgId: org.id,
				ownerUserId: user.id,
				agentId: agent.id,
				connectionId: request.connection.id,
				collectionId,
				action: request.action,
				recordTitle: onOneRecord ? recordTitle(request.connection, collectionId) : null,
				query: searched ? pick(SEARCHES) : null,
				...outcomeOf(agent, request),
				via,
				taskId,
				durationMs: requestDuration(),
				createdAt: new Date(createdAt),
			},
		});
		entryCount += 1;
	}

	await db.agent.update({where: {id: agent.id}, data: {lastActiveAt: new Date(lastActiveAt)}});
}

// Each task's last activity is no earlier than the last request made for it or its sub-tasks at any
// depth, as the api keeps it.
await db.$executeRaw`
	WITH RECURSIVE "below" AS (
		SELECT "id" AS "taskId", "id" FROM "AgentTask" WHERE "orgId" = ${org.id}
		UNION ALL
		SELECT "below"."taskId", "task"."id"
		FROM "AgentTask" AS "task"
		JOIN "below" ON "task"."parentId" = "below"."id"
	)
	UPDATE "AgentTask"
	SET "lastActiveAt" = "latest"."at"
	FROM (
		SELECT "below"."taskId", MAX("entry"."createdAt") AS "at"
		FROM "below"
		JOIN "AuditEntry" AS "entry" ON "entry"."taskId" = "below"."id"
		GROUP BY "below"."taskId"
	) AS "latest"
	WHERE "AgentTask"."id" = "latest"."taskId" AND "latest"."at" > "AgentTask"."lastActiveAt"`;

// ---- A sign-in link -------------------------------------------------------------------------

// A magic link as the api makes one (`packages/api/src/auth/email.ts`): only the token's hash is
// stored, and it works once.
const token = randomBytes(32).toString('hex');
must(
	await createVerificationToken({
		identifier: DEMO_EMAIL,
		token: hashVerificationToken(token, authSecret),
		expires: new Date(now + DAY),
	}),
);
const apiUrl = process.env.VITE_PROXY_API_URL ?? 'http://localhost:4000';
const query = new URLSearchParams({
	token,
	email: DEMO_EMAIL,
	callbackUrl: `/${org.slug}/agents`,
});

console.log(`[seed] ${connections.length} connections, ${agents.length} agents, ${taskCount} tasks and ${entryCount} activity entries for ${DEMO_EMAIL}.`);
console.log(`[seed] Sign in, once, within 24 hours: ${apiUrl}/auth/email/verify?${query}`);
console.log(`[seed] Later, ask for a magic link for ${DEMO_EMAIL}; the api prints it.`);
console.log(`[seed] Agents sign in at /agent/login with their username and "${AGENT_PASSWORD}".`);
await disconnectDb();
