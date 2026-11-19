// `bun run seed:showcase`: fills one person's workspace with the showcase (scripts/showcase): made-up
// connections, outside agents with settings of their own and weeks of their work, personas with
// threads, sub-agents and alerts, as the api would have written them. For showing the product to an
// audience, on the person's own account.
//
// SEED_EMAIL names the person. Locally, they are made where they don't exist yet, and a sign-in
// link is printed. Against any other database, the person must exist, own a workspace of their
// own with nobody else in it, and SEED_PRODUCTION must repeat their email.
//
// Running it again deletes what it seeded before (by the names it gives things) and seeds it again,
// with times relative to now: run it shortly before showing it. Nothing it makes runs on its own:
// threads have no jobs, alerts are never due (no `nextAt`) and watches have no polls, so no agent
// is woken and no fake credential is ever sent to a provider by the server itself.
import {randomBytes} from 'node:crypto';

import {Result} from 'ts-results-es';
import {z} from 'zod';

import type {ApiError} from '@proxy/utils';
import {CREATE_SUBAGENT_TOOL, cut, SEND_TO_PERSON_TOOL, shuffleLook, type ToolCall} from '@proxy/utils/harness';
import {hashVerificationToken, secretCipher} from '@proxy/utils/secret-crypto';
import {db, disconnectDb} from '@proxy/db';
import {createAgent, setAgentGrants} from '@proxy/db/agent';
import type {AlertRow} from '@proxy/db/alerts';
import {createVerificationToken} from '@proxy/db/auth';
import {createConnection} from '@proxy/db/connection';
import {ensureFirstPersona, ensureMemberChat} from '@proxy/db/harness';
import {createStarterConnections, provisionOrganization, renameOrganization} from '@proxy/db/organization';
import {createVaultEntry} from '@proxy/db/vault';

import {getBuiltInAgent, newBuiltInAgent} from '../src/harness/built-in-agent';
import {dueText, matchText, SET_ALERT_TOOL} from '../src/harness/alerts';
import {SCRIPT_TOOL} from '../src/mcp/tools';
import {MEMBER_CONNECTIONS, NAMED_AFTER_ORGANIZATION} from '../src/orgs/starter-connections';
import type {Act, AgentKey, ConnectionKey, PersonaKey, Step, SubAgent} from './showcase/kit';
import {AGENTS, ARNE, CONNECTIONS, type ConnectionSpec, HANDBOOK, OBSERVABILITY_TOOLS, PERSONAS, SANDBOXES, stories, TIME_ZONE, VAULT_ENTRIES, WORKSPACE} from './showcase/stories';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const MAX_TASK_TEXT = 2000;
// What a sub-agent's answer is followed by for the thread it works for (thread-rules.ts).
const STOPPED_NOTE = '(It has stopped; a message takes it up again.)';
const now = Date.now();
// What of a vault entry tells a seeded one: its title.
const vaultTitleSchema = z.object({title: z.string()});

function fail(message: string): never {
	console.error(`[showcase] ${message}`);
	process.exit(1);
}

function must<T>(result: Result<T, ApiError>): T {
	if (result.isErr()) {
		return fail(`Failed: ${JSON.stringify(result.error)}`);
	}
	return result.value;
}

// ---- Where ----------------------------------------------------------------------------------

const email = process.env.SEED_EMAIL ?? '';
const databaseUrl = process.env.DATABASE_URL;
const encryptionKey = process.env.ENCRYPTION_KEY;
if (!email) {
	fail('Name the person with SEED_EMAIL.');
}
if (!databaseUrl || !URL.canParse(databaseUrl)) {
	fail('DATABASE_URL is missing.');
}
if (!encryptionKey) {
	fail('ENCRYPTION_KEY is needed, the api’s own, so it can read the connections’ credentials.');
}
const local = LOCAL_HOSTS.has(new URL(databaseUrl).hostname);
if (!local && process.env.SEED_PRODUCTION !== email) {
	fail(`DATABASE_URL is not the local database. To seed ${email} there, set SEED_PRODUCTION=${email}.`);
}
const dryRun = process.argv.includes('--dry-run');
const cipher = secretCipher(Buffer.from(encryptionKey, 'base64'));
const encrypt = (value: unknown) => cipher.encrypt(JSON.stringify(value));

// Deterministic, so a run makes the same showcase as the last.
let randomState = 7;
function random(): number {
	randomState = (randomState * 1664525 + 1013904223) % 2 ** 32;
	return randomState / 2 ** 32;
}
const between = (low: number, high: number) => low + random() * (high - low);
const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
// An id as Claude gives a tool call.
const callId = () => `toolu_01${Array.from({length: 22}, () => BASE62[Math.floor(random() * 62)]).join('')}`;

// ---- The person and their workspace ----------------------------------------------------------

async function findOrMakeWorkspace(): Promise<{userId: string; orgId: string; orgName: string; slug: string}> {
	const user = await db.user.findUnique({where: {email}, select: {id: true}});
	if (!user && !local) {
		return fail(`${email} has no account here; sign up first.`);
	}
	if (!user) {
		const made = must(
			await provisionOrganization({
				owner: {user: {email, name: 'Konstantin Hohr', emailVerified: new Date(), createdAt: new Date(now - 30 * DAY)}},
				name: "Konstantin's Workspace",
				slugSource: 'konstantins-workspace',
				onboardedAt: new Date(now - 30 * DAY),
				builtInAgent: await newBuiltInAgent(),
				connections: MEMBER_CONNECTIONS,
			}),
		);
		return {userId: made.ownerUserId, orgId: made.org.id, orgName: made.org.name, slug: made.org.slug};
	}
	const orgs = await db.organization.findMany({
		where: {ownerUserId: user.id},
		select: {id: true, name: true, slug: true, _count: {select: {members: true}}},
	});
	const [org] = orgs;
	if (!org || orgs.length > 1) {
		return fail(`${email} owns ${orgs.length} workspaces; the showcase needs exactly one.`);
	}
	// Nobody but the person and the cofounder the showcase adds.
	const members = await db.orgMember.findMany({where: {orgId: org.id}, select: {user: {select: {email: true}}}});
	const others = members.filter((member) => member.user.email !== email && member.user.email !== ARNE.email);
	if (others.length > 0) {
		return fail(`${org.name} has other members (${others.map((member) => member.user.email).join(', ')}); the showcase only seeds a workspace of its own people.`);
	}
	return {userId: user.id, orgId: org.id, orgName: org.name, slug: org.slug};
}

const workspace = await findOrMakeWorkspace();
const {userId, orgId} = workspace;

// Named and addressed as the showcase's workspace, where the address is free; renamed as the api
// renames one, its vaults and the like named after it too.
async function renameWorkspace(): Promise<{orgName: string; slug: string}> {
	if (workspace.orgName !== WORKSPACE.name && !dryRun) {
		must(await renameOrganization(orgId, WORKSPACE.name, NAMED_AFTER_ORGANIZATION));
	}
	if (workspace.slug === WORKSPACE.slug) {
		return {orgName: WORKSPACE.name, slug: WORKSPACE.slug};
	}
	const taken = await db.organization.findUnique({where: {slug: WORKSPACE.slug}, select: {id: true}});
	if (taken) {
		console.log(`[showcase] /${WORKSPACE.slug} is another workspace's; keeping /${workspace.slug}.`);
		return {orgName: WORKSPACE.name, slug: workspace.slug};
	}
	if (!dryRun) {
		await db.organization.update({where: {id: orgId}, data: {slug: WORKSPACE.slug}});
	}
	return {orgName: WORKSPACE.name, slug: WORKSPACE.slug};
}

const {orgName, slug} = await renameWorkspace();
// Chat's connection is called by the workspace's name too, but renaming one leaves it as it was
// (NAMED_AFTER_ORGANIZATION has no chat); renamed here so it matches.
if (!dryRun) {
	await db.connection.updateMany({where: {orgId, integrationId: 'chat'}, data: {account: orgName}});
}

// Arne, Konsti's cofounder: a member since three weeks ago, with his own vault as anyone who joins
// gets. Kept between runs; never signs in unless someone asks for a link to his address.
async function ensureArne(): Promise<string> {
	const found = await db.user.findUnique({where: {email: ARNE.email}, select: {id: true}});
	if (dryRun) {
		return found?.id ?? '';
	}
	const since = new Date(now - ARNE.daysAgo * DAY);
	const arne = found ?? (await db.user.create({data: {email: ARNE.email, name: ARNE.name, emailVerified: since, createdAt: since}, select: {id: true}}));
	const member = await db.orgMember.findUnique({where: {orgId_userId: {orgId, userId: arne.id}}, select: {id: true}});
	if (!member) {
		await db.$transaction(async (tx) => {
			await tx.orgMember.create({data: {orgId, userId: arne.id, createdAt: since}});
			await createStarterConnections(tx, MEMBER_CONNECTIONS, {orgId, userId: arne.id, name: orgName});
		});
	}
	return arne.id;
}

const arneId = await ensureArne();

// The workspace, Konsti's membership and General from before anything seeded, a month ago, so the
// Members page has him joining first and General stays the oldest of the personas everyone sees,
// which is what the app takes it for.
const MONTH_AGO = new Date(now - 30 * DAY);
if (!dryRun) {
	must(await ensureFirstPersona(orgId));
	await db.organization.updateMany({where: {id: orgId, createdAt: {gt: MONTH_AGO}}, data: {createdAt: MONTH_AGO}});
	await db.orgMember.updateMany({where: {orgId, userId, createdAt: {gt: MONTH_AGO}}, data: {createdAt: MONTH_AGO}});
	await db.persona.updateMany({where: {orgId, ownerUserId: null, name: {notIn: Object.values(PERSONAS).map((persona) => persona.name)}, createdAt: {gt: MONTH_AGO}}, data: {createdAt: MONTH_AGO}});
}
const ownerOf = (spec: ConnectionSpec) => (spec.owner === 'arne' ? arneId : userId);
const builtIn = must(await getBuiltInAgent(orgId));
const usernames = Object.values(AGENTS).map((agent) => agent.username);
const personaNames: string[] = Object.values(PERSONAS).map((persona) => persona.name);
const story = stories(now);
const generalTitles = story.threads.filter((thread) => thread.persona === 'general').map((thread) => thread.title);

// ---- What the last run seeded, deleted --------------------------------------------------------

async function reset() {
	const specs: ConnectionSpec[] = Object.values(CONNECTIONS);
	const connections = await db.connection.findMany({
		where: {
			orgId,
			OR: [...specs.map((spec) => ({ownerUserId: ownerOf(spec), integrationId: spec.integrationId, account: spec.account})), {ownerUserId: userId, integrationId: 'vault', name: HANDBOOK.name}],
		},
		select: {id: true, integrationId: true, account: true},
	});
	const agents = await db.agent.findMany({where: {orgId, username: {in: usernames}}, select: {id: true, name: true}});
	const personas = await db.persona.findMany({where: {orgId, OR: [{ownerUserId: userId}, {ownerUserId: null}], name: {in: personaNames}}, select: {id: true, name: true}});
	const general = await db.persona.findFirst({where: {orgId, ownerUserId: null, name: {notIn: personaNames}}, orderBy: {createdAt: 'asc'}, select: {id: true}});
	const generalChat = general ? await db.agentThread.findFirst({where: {personaId: general.id, userId, parentThreadId: null}, select: {id: true}}) : null;
	const generalThreads = generalChat ? await db.agentThread.findMany({where: {parentThreadId: generalChat.id, subAgentOfId: null, title: {in: generalTitles}}, select: {id: true}}) : [];
	const threads = await db.agentThread.findMany({
		where: {
			OR: [{personaId: {in: personas.map((persona) => persona.id)}, userId}, {id: {in: generalThreads.map((thread) => thread.id)}}, {subAgentOfId: {in: generalThreads.map((thread) => thread.id)}}],
		},
		select: {id: true, taskId: true},
	});
	const taskIds = threads.flatMap((thread) => (thread.taskId ? [thread.taskId] : []));
	const vault = await db.connection.findFirst({where: {orgId, ownerUserId: userId, integrationId: 'vault', sharedWithEveryone: false}, select: {id: true}});
	// Konsti's entries, and any of the handbook's an earlier version kept in his vault.
	const vaultTitles = new Set([...VAULT_ENTRIES, ...HANDBOOK.entries].map((entry) => entry.title));
	const entries = vault ? await db.vaultEntry.findMany({where: {connectionId: vault.id}, select: {id: true, values: true}}) : [];
	const seededEntries = entries.filter((entry) => {
		const values = cipher.decrypt(entry.values).andThen((plain) => Result.wrap(() => vaultTitleSchema.parse(JSON.parse(plain))));
		return values.isOk() && vaultTitles.has(values.value.title);
	});
	const sandboxes = await db.sandbox.findMany({where: {orgId, name: {in: SANDBOXES}}, select: {id: true}});

	console.log(
		`[showcase] Last run's: ${connections.length} connections, ${agents.length} agents, ${personas.length} personas, ${threads.length} threads, ${seededEntries.length} vault entries, ${sandboxes.length} sandboxes.`,
	);
	if (dryRun) {
		return;
	}
	const agentIds = agents.map((agent) => agent.id);
	// Tasks of the seeded threads, their sub-tasks, and every task of the seeded agents.
	const allTaskIds = [...taskIds, ...(await db.agentTask.findMany({where: {orgId, OR: [{agentId: {in: agentIds}}, {parentId: {in: taskIds}}]}, select: {id: true}})).map((task) => task.id)];
	await db.$transaction([
		db.auditEntry.deleteMany({where: {orgId, OR: [{taskId: {in: allTaskIds}}, {agentId: {in: agentIds}}, {connectionId: {in: connections.map((connection) => connection.id)}}]}}),
		db.agentAlert.deleteMany({where: {orgId, userId, OR: [{chat: {personaId: {in: personas.map((persona) => persona.id)}}}, {threadId: {in: threads.map((thread) => thread.id)}}]}}),
		db.agentThread.deleteMany({where: {id: {in: threads.map((thread) => thread.id)}}}),
		db.agentTask.deleteMany({where: {id: {in: allTaskIds}}}),
		db.persona.deleteMany({where: {id: {in: personas.map((persona) => persona.id)}}}),
		db.agent.deleteMany({where: {id: {in: agentIds}}}),
		db.connection.deleteMany({where: {id: {in: connections.map((connection) => connection.id)}}}),
		db.vaultEntry.deleteMany({where: {id: {in: seededEntries.map((entry) => entry.id)}}}),
		db.sandbox.deleteMany({where: {id: {in: sandboxes.map((sandbox) => sandbox.id)}}}),
	]);
}

await reset();
if (dryRun) {
	console.log('[showcase] Dry run: nothing deleted or made.');
	await disconnectDb();
	process.exit(0);
}

// ---- Connections ----------------------------------------------------------------------------

// Made-up tokens: the pages work, anything that asks the provider fails.
function credentialOf(key: keyof typeof CONNECTIONS): string {
	const token = {accessToken: `showcase-${key}`, refreshToken: null, expiresAt: null};
	if (key === 'google' || key === 'arneCalendar') {
		return encrypt({
			...token,
			scopes: [
				'openid',
				'https://www.googleapis.com/auth/userinfo.email',
				'https://www.googleapis.com/auth/gmail.modify',
				'https://www.googleapis.com/auth/calendar.events',
				'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
				'https://www.googleapis.com/auth/calendar.events.freebusy',
				'https://www.googleapis.com/auth/drive',
				'https://www.googleapis.com/auth/contacts',
			],
			email: CONNECTIONS[key].account,
		});
	}
	if (key === 'support') {
		return encrypt({
			imap: {host: 'imap.gmail.com', port: 993, secure: true},
			smtp: {host: 'smtp.gmail.com', port: 465, secure: true},
			username: CONNECTIONS.support.account,
			password: 'abcd-efgh-ijkl-mnop',
		});
	}
	if (key === 'github') {
		return encrypt({...token, id: '4815162', login: 'hkonsti', name: 'Konstantin Hohr'});
	}
	if (key === 'plaid') {
		return encrypt({accessToken: 'access-showcase', itemId: 'item-showcase'});
	}
	if (key === 'exa') {
		return encrypt({auth: 'key', key: 'showcase-exa-key'});
	}
	if (key === 'observability') {
		return encrypt({auth: 'token', url: `https://${CONNECTIONS.observability.account}`, token: 'showcase-token'});
	}
	return encrypt({clientId: 'showcase-client', ...token});
}

const observabilityTools = OBSERVABILITY_TOOLS.map(({name, title, description, props}) => ({
	name,
	title,
	description,
	inputSchema: {type: 'object', properties: Object.fromEntries(Object.entries(props).map(([prop, about]) => [prop, {type: 'string', description: about}]))},
	annotations: {readOnlyHint: true},
}));

const connectionIds = {} as Record<ConnectionKey, string>;
for (const [key, spec] of Object.entries(CONNECTIONS) as Array<[keyof typeof CONNECTIONS, ConnectionSpec]>) {
	const made = must(
		await createConnection({
			orgId,
			ownerUserId: ownerOf(spec),
			sharedWithEveryone: spec.share === 'everyone',
			integrationId: spec.integrationId,
			account: spec.account,
			credential: credentialOf(key),
			defaults: [...spec.defaults],
			...(key === 'observability' ? {tools: JSON.stringify(observabilityTools), name: CONNECTIONS.observability.name} : {}),
		}),
	);
	await db.connection.update({where: {id: made.id}, data: {createdAt: new Date(now - spec.daysAgo * DAY)}});
	if (spec.share === 'konsti') {
		await db.connectionShare.create({data: {connectionId: made.id, userId}});
	}
	connectionIds[key] = made.id;
}

// The vault and Sandboxes the workspace was made with.
const vault = await db.connection.findFirst({where: {orgId, ownerUserId: userId, integrationId: 'vault', sharedWithEveryone: false}, orderBy: {createdAt: 'asc'}, select: {id: true}});
if (!vault) {
	fail('The workspace has no vault of its own.');
}
connectionIds.vault = vault.id;
const existingSandboxes = await db.connection.findFirst({where: {orgId, ownerUserId: userId, integrationId: 'sandbox'}, select: {id: true}});
connectionIds.sandboxes = existingSandboxes?.id ?? must(await createConnection({orgId, ownerUserId: userId, integrationId: 'sandbox', account: orgName, defaults: ['read', 'run', 'delete']})).id;

for (const values of VAULT_ENTRIES) {
	must(await createVaultEntry({connectionId: vault.id, collectionId: 'entries'}, encrypt(values)));
}

// The team's vault, made beside Konsti's own as the app's Add connection makes one, for everyone.
const vaultDefaults = await db.connectionDefault.findMany({where: {connectionId: vault.id}, select: {actionId: true}});
const handbook = must(
	await createConnection({
		orgId,
		ownerUserId: userId,
		sharedWithEveryone: true,
		integrationId: 'vault',
		account: orgName,
		name: HANDBOOK.name,
		defaults: vaultDefaults.map((stored) => stored.actionId),
	}),
);
await db.connection.update({where: {id: handbook.id}, data: {createdAt: new Date(now - 19 * DAY)}});
connectionIds.handbook = handbook.id;
for (const values of HANDBOOK.entries) {
	must(await createVaultEntry({connectionId: handbook.id, collectionId: 'entries'}, encrypt(values)));
}

// Asleep, as a sandbox is between uses: nothing wakes one but a command.
const sandboxRefs = new Map<string, string>();
for (const [index, name] of SANDBOXES.entries()) {
	const backendRef = randomBytes(10).toString('hex');
	sandboxRefs.set(name, backendRef);
	await db.sandbox.create({
		data: {
			orgId,
			connectionId: connectionIds.sandboxes,
			name,
			state: 'asleep',
			backendId: 'remote',
			backendRef,
			lastUsedAt: new Date(now - (index + 1) * 5 * HOUR),
			createdAt: new Date(now - (index + 2) * 2 * DAY),
		},
	});
}

// ---- Outside agents ---------------------------------------------------------------------------

// Nobody signs in as them: they show and are changed on the Agents page.
const passwordHash = await Bun.password.hash(randomBytes(24).toString('hex'));
const agentIds = {} as Record<AgentKey, string>;
// Whose an agent's log is: Konsti's for his own, everyone's (null) for the team's.
const logOwner = new Map<string, string | null>([[builtIn.id, userId]]);
for (const [key, spec] of Object.entries(AGENTS) as Array<[AgentKey, (typeof AGENTS)[AgentKey]]>) {
	const shared = 'shared' in spec && spec.shared;
	const agent = must(await createAgent({orgId, ownerUserId: shared ? null : userId, createdById: userId, providerId: spec.providerId, name: spec.name, username: spec.username, passwordHash}));
	await db.agent.update({where: {id: agent.id}, data: {createdAt: new Date(now - spec.daysAgo * DAY)}});
	for (const [connection, actions] of Object.entries(spec.grants) as Array<[ConnectionKey, Record<string, boolean>]>) {
		must(await setAgentGrants({agentId: agent.id, connectionId: connectionIds[connection], actions}));
	}
	agentIds[key] = agent.id;
	logOwner.set(agent.id, shared ? null : userId);
}

function ownerOfLog(agentId: string): string | null {
	const owner = logOwner.get(agentId);
	return owner === undefined ? userId : owner;
}

// ---- Activity ---------------------------------------------------------------------------------

let entryCount = 0;
const lastActive = new Map<string, number>();

// Logs the requests one after another from `from`, a second or a few apart, each as long as it
// took; answers when the last was done.
async function logActs(acts: Act[], from: number, who: {agentId: string; taskId: string; via: 'harness' | 'mcp' | 'cli'}): Promise<number> {
	let at = from;
	for (const act of acts) {
		const durationMs = act.ms ?? Math.round(between(200, 1500));
		const query =
			act.command !== undefined
				? JSON.stringify({sandbox: sandboxRefs.get(act.sandbox ?? '') ?? act.sandbox, pap: act.command.includes('pap ') || undefined, command: act.command})
				: (act.query ?? null);
		await db.auditEntry.create({
			data: {
				orgId,
				ownerUserId: ownerOfLog(who.agentId),
				agentId: who.agentId,
				connectionId: connectionIds[act.on],
				collectionId: act.collection,
				action: act.action,
				recordTitle: act.title ?? null,
				query,
				outcome: act.outcome ?? 'allowed',
				error: act.outcome === 'failed' ? (act.error ?? 'provider_unreachable') : null,
				via: who.via,
				taskId: who.taskId,
				durationMs,
				createdAt: new Date(at),
			},
		});
		entryCount += 1;
		at += durationMs + between(800, 4000);
	}
	lastActive.set(who.agentId, Math.max(lastActive.get(who.agentId) ?? 0, at));
	return at;
}

// ---- Personas, their chats and threads ---------------------------------------------------------

const general = must(await ensureFirstPersona(orgId));
const personaIds: Record<PersonaKey, string> = {general: general.id} as Record<PersonaKey, string>;
const personaModels: Record<PersonaKey, {harness: string; chatModel: string}> = {general: {harness: general.harness, chatModel: general.chatModel}} as Record<
	PersonaKey,
	{harness: string; chatModel: string}
>;
for (const [index, [key, spec]] of (Object.entries(PERSONAS) as Array<[Exclude<PersonaKey, 'general'>, (typeof PERSONAS)[Exclude<PersonaKey, 'general'>]]>).entries()) {
	const persona = await db.persona.create({
		data: {
			orgId,
			// The team's, which every member sees, or Konsti's own.
			ownerUserId: 'shared' in spec && spec.shared ? null : userId,
			createdById: userId,
			name: spec.name,
			look: JSON.stringify(shuffleLook(random)),
			color: spec.color,
			harness: spec.harness,
			chatModel: spec.chatModel,
			createdAt: new Date(now - (14 - index) * DAY),
		},
	});
	personaIds[key] = persona.id;
	personaModels[key] = {harness: spec.harness, chatModel: spec.chatModel};
}
const chats = {} as Record<PersonaKey, string>;
for (const key of Object.keys(personaIds) as PersonaKey[]) {
	chats[key] = must(await ensureMemberChat({orgId, agentId: builtIn.id, personaId: personaIds[key], userId})).id;
}

type Made = {id: string; taskId: string};
const threadIds = new Map<string, Made>();

// Each thread's row and task first, so the alerts set in one can name it.
for (const thread of story.threads) {
	const model = personaModels[thread.persona];
	const opener = thread.steps[0];
	const goal = thread.opened ? (story.alerts.find((alert) => alert.key === thread.opened?.alert)?.brief ?? thread.title) : opener && 'person' in opener ? opener.person : thread.title;
	const task = await db.agentTask.create({
		data: {
			orgId,
			agentId: builtIn.id,
			ownerUserId: userId,
			personaId: personaIds[thread.persona],
			parentId: null,
			title: thread.title,
			goal: cut(goal, MAX_TASK_TEXT),
			via: 'harness',
			createdAt: thread.start,
			lastActiveAt: thread.start,
			lastStartedAt: thread.start,
		},
	});
	const row = await db.agentThread.create({
		data: {
			orgId,
			agentId: builtIn.id,
			personaId: personaIds[thread.persona],
			userId,
			parentThreadId: chats[thread.persona],
			title: thread.title,
			titleWritten: !thread.opened,
			taskId: task.id,
			openedByAlert: thread.opened !== undefined,
			chosenHarness: model.harness,
			chosenModel: model.chatModel,
			harness: model.harness,
			createdAt: thread.start,
		},
	});
	threadIds.set(thread.title, {id: row.id, taskId: task.id});
}

// The alerts that open threads in a chat, set in one of its threads; never due, never polled.
const alertRows = new Map<string, AlertRow>();
for (const alert of story.alerts) {
	const setIn = threadIds.get(alert.setIn);
	const opened = story.threads.filter((thread) => thread.opened?.alert === alert.key);
	const setAt = story.threads.find((thread) => thread.title === alert.setIn)?.start ?? new Date(now);
	const row = await db.agentAlert.create({
		data: {
			orgId,
			userId,
			chatId: chats[alert.persona],
			threadId: null,
			setInThreadId: setIn?.id ?? null,
			title: alert.title,
			brief: alert.brief,
			createdAt: new Date(setAt.getTime() + 1.4 * MINUTE),
			...(alert.kind === 'watch'
				? {collectionId: alert.collection, connectionIds: alert.on.map((key) => connectionIds[key]), terms: alert.terms, split: alert.split, lastMatchedAt: opened.at(-1)?.start ?? null}
				: {at: alert.at, nextAt: null, every: alert.every, timeZone: alert.timeZone}),
		},
	});
	alertRows.set(alert.key, row);
}

// What an assistant entry cost, a little more each step of the thread.
let contextTokens = 0;
function tokens() {
	contextTokens += Math.round(between(900, 2600));
	return {inputTokens: contextTokens, outputTokens: Math.round(between(120, 900))};
}

type Written = {lastAt: number; answer: string; lastPersonAt: number; maxSeq: number; lastPersonSeq: number};

// Writes a thread's log from its steps, with the requests its scripts made and its sub-agents'
// threads, and answers how it ended.
async function writeLog(
	made: Made,
	steps: Step[],
	start: number,
	model: {harness: string; chatModel: string},
	persona: PersonaKey,
	subAgentsOf: Map<string, {id: string; callId: string; answer: string}>,
): Promise<Written> {
	const written: Written = {lastAt: start, answer: '', lastPersonAt: start, maxSeq: 0, lastPersonSeq: 0};
	contextTokens = Math.round(between(9000, 14000));
	const entry = async (data: {kind: 'person' | 'assistant' | 'tool_result' | 'event'; text: string; at: number; toolCalls?: ToolCall[]; callId?: string}) => {
		const assistant = data.kind === 'assistant';
		const row = await db.agentEntry.create({
			data: {
				threadId: made.id,
				kind: data.kind,
				text: data.text,
				toolCalls: data.toolCalls ? JSON.stringify(data.toolCalls) : null,
				callId: data.callId ?? null,
				...(assistant ? {...tokens(), harness: model.harness, model: model.chatModel} : {}),
				createdAt: new Date(data.at),
			},
		});
		written.maxSeq = Math.max(written.maxSeq, row.seq);
		written.lastAt = Math.max(written.lastAt, data.at);
		return row;
	};
	const who = {agentId: builtIn.id, taskId: made.taskId, via: 'harness' as const};
	for (const step of steps) {
		const at = start + step.at * MINUTE;
		if ('person' in step) {
			const row = await entry({kind: 'person', text: step.person, at});
			written.lastPersonAt = at;
			written.lastPersonSeq = row.seq;
			continue;
		}
		if ('script' in step) {
			const call = {id: callId(), name: SCRIPT_TOOL, arguments: JSON.stringify({code: step.script})};
			await entry({kind: 'assistant', text: step.say ?? '', at, toolCalls: [call]});
			const done = await logActs(step.acts, at + between(1500, 3500), who);
			await entry({kind: 'tool_result', text: step.result, at: done, callId: call.id});
			continue;
		}
		if ('tell' in step) {
			const call = {id: callId(), name: SEND_TO_PERSON_TOOL, arguments: JSON.stringify({text: step.tell})};
			await entry({kind: 'assistant', text: '', at, toolCalls: [call]});
			await entry({kind: 'tool_result', text: 'Sent.', at: at + 400, callId: call.id});
			continue;
		}
		if ('subAgents' in step) {
			const calls = step.subAgents.map((sub) => ({sub, call: {id: callId(), name: CREATE_SUBAGENT_TOOL, arguments: JSON.stringify({title: sub.title, brief: sub.brief})}}));
			await entry({kind: 'assistant', text: step.say ?? '', at, toolCalls: calls.map(({call}) => call)});
			for (const {sub, call} of calls) {
				const subMade = await writeSubAgent(sub, call.id, made, at, model, persona);
				subAgentsOf.set(sub.title, {id: subMade.id, callId: call.id, answer: subMade.answer});
				await entry({kind: 'tool_result', text: `Started “${sub.title}”, id ${subMade.id}. What it says comes to you as a message.`, at: at + 600, callId: call.id});
			}
			continue;
		}
		if ('report' in step) {
			const sub = subAgentsOf.get(step.report);
			if (!sub) {
				fail(`No sub-agent “${step.report}” was started before it reports.`);
			}
			await entry({kind: 'event', text: `${sub.answer}\n\n${STOPPED_NOTE}`, at, callId: sub.callId});
			continue;
		}
		const calls: ToolCall[] = step.alert
			? [{id: callId(), name: SET_ALERT_TOOL, arguments: JSON.stringify({title: step.alert.title, brief: step.alert.brief, opens: 'this_thread', at: step.alert.at.toISOString()})}]
			: [];
		if (step.alert) {
			// The alert, set as the answer's call, then the answer said once it was.
			const [call] = calls;
			await entry({kind: 'assistant', text: '', at: at - 0.3 * MINUTE, toolCalls: calls});
			await entry({kind: 'tool_result', text: `Set “${step.alert.title}”.`, at: at - 0.2 * MINUTE, callId: call?.id});
			await db.agentAlert.create({
				data: {
					orgId,
					userId,
					chatId: chats[persona],
					threadId: made.id,
					setInThreadId: made.id,
					title: step.alert.title,
					brief: step.alert.brief,
					at: step.alert.at,
					nextAt: null,
					timeZone: TIME_ZONE,
					createdAt: new Date(at),
				},
			});
		}
		await entry({kind: 'assistant', text: step.answer, at});
		written.answer = step.answer;
	}
	return written;
}

// A sub-agent's thread, under the thread that started it, with its own task under the thread's.
async function writeSubAgent(sub: SubAgent, parentCallId: string, parent: Made, at: number, model: {harness: string; chatModel: string}, persona: PersonaKey): Promise<{id: string; answer: string}> {
	const lastStep = sub.steps.at(-1);
	const endsAt = at + (lastStep?.at ?? 0) * MINUTE;
	const task = await db.agentTask.create({
		data: {
			orgId,
			agentId: builtIn.id,
			ownerUserId: userId,
			personaId: personaIds[persona],
			parentId: parent.taskId,
			title: sub.title,
			goal: cut(sub.brief, MAX_TASK_TEXT),
			via: 'harness',
			createdAt: new Date(at),
			lastActiveAt: new Date(endsAt),
			lastStartedAt: new Date(at),
		},
	});
	const row = await db.agentThread.create({
		data: {
			orgId,
			agentId: builtIn.id,
			personaId: personaIds[persona],
			userId,
			parentThreadId: chats[persona],
			subAgentOfId: parent.id,
			parentCallId,
			title: sub.title,
			taskId: task.id,
			chosenHarness: model.harness,
			chosenModel: model.chatModel,
			harness: model.harness,
			createdAt: new Date(at),
		},
	});
	const made = {id: row.id, taskId: task.id};
	const steps: Step[] = [{at: 0, person: sub.brief}, ...sub.steps];
	const saved = contextTokens;
	const written = await writeLog(made, steps, at, model, persona, new Map());
	contextTokens = saved;
	await db.agentTask.update({where: {id: task.id}, data: {finishedAt: new Date(written.lastAt), outcome: cut(written.answer, MAX_TASK_TEXT), lastActiveAt: new Date(written.lastAt)}});
	await db.agentThread.update({where: {id: row.id}, data: {readSeq: written.maxSeq, summarySeq: written.maxSeq}});
	return {id: row.id, answer: written.answer};
}

for (const thread of story.threads) {
	const made = threadIds.get(thread.title);
	if (!made) {
		continue;
	}
	const steps: Step[] = [...thread.steps];
	if (thread.opened) {
		const alert = alertRows.get(thread.opened.alert);
		if (!alert) {
			fail(`No alert “${thread.opened.alert}” for the thread “${thread.title}”.`);
		}
		const setIn = story.alerts.find((spec) => spec.key === thread.opened?.alert)?.setIn ?? null;
		const text = thread.opened.change ? matchText(alert, [thread.opened.change], setIn) : dueText(alert, setIn);
		await db.agentEntry.create({data: {threadId: made.id, kind: 'event', text, createdAt: thread.start}});
	}
	const written = await writeLog(made, steps, thread.start.getTime(), personaModels[thread.persona], thread.persona, new Map());
	await db.agentTask.update({
		where: {id: made.taskId},
		data: {finishedAt: new Date(written.lastAt), outcome: cut(written.answer, MAX_TASK_TEXT), lastStartedAt: new Date(written.lastPersonAt), lastActiveAt: new Date(written.lastAt)},
	});
	await db.agentThread.update({
		where: {id: made.id},
		data: {
			waitingForMember: thread.waiting === true,
			summary: thread.summary,
			summarySeq: written.maxSeq,
			readSeq: thread.unread ? written.lastPersonSeq : written.maxSeq,
			updatedAt: new Date(written.lastAt),
		},
	});
}

// ---- What the outside agents did ---------------------------------------------------------------

let taskCount = 0;
async function writeTask(task: {agent: AgentKey; title: string; goal: string; start: Date; minutes: number; outcome: string | null; via?: 'mcp' | 'cli'; acts: Act[]}) {
	const agentId = agentIds[task.agent];
	const start = task.start.getTime();
	const via = task.via ?? 'mcp';
	const made = await db.agentTask.create({
		data: {orgId, agentId, ownerUserId: ownerOfLog(agentId), title: task.title, goal: task.goal, via, createdAt: task.start, lastStartedAt: task.start, lastActiveAt: task.start},
	});
	taskCount += 1;
	// The requests spread over the task, the last near its end, or, under way, a moment ago.
	const span = task.outcome === null ? Math.min(task.minutes * MINUTE, now - start - 30 * 1000) : task.minutes * MINUTE;
	let at = start + 20 * 1000;
	for (const [index, act] of task.acts.entries()) {
		at = Math.max(at, start + (span * (index + 0.5)) / task.acts.length);
		at = await logActs([act], at, {agentId, taskId: made.id, via});
	}
	const end = task.outcome === null ? Math.min(at, now - 20 * 1000) : start + task.minutes * MINUTE;
	await db.agentTask.update({where: {id: made.id}, data: {lastActiveAt: new Date(Math.min(at, now)), finishedAt: task.outcome === null ? null : new Date(Math.max(end, at)), outcome: task.outcome}});
}

for (const task of story.tasks) {
	await writeTask(task);
}
// The weeks around them: each agent's routine work, a few times a week since it was connected,
// during the day in San Francisco.
const PST_OFFSET = -8 * HOUR;
const midnight = Math.floor((now + PST_OFFSET) / DAY) * DAY - PST_OFFSET;
for (const [key, spec] of Object.entries(AGENTS) as Array<[AgentKey, (typeof AGENTS)[AgentKey]]>) {
	const routine = story.routine.filter((task) => task.agent === key);
	const count = Math.round(spec.daysAgo * 0.8);
	for (let index = 0; index < count && routine.length > 0; index++) {
		const daysBack = 1 + Math.floor(random() * (spec.daysAgo - 1));
		const start = midnight - daysBack * DAY + between(9, 19) * HOUR;
		if (start > now - 2 * HOUR) {
			continue;
		}
		const picked = routine[Math.floor(random() * routine.length)];
		if (picked) {
			await writeTask({...picked, start: new Date(start)});
		}
	}
}

for (const [agentId, at] of lastActive) {
	await db.agent.update({where: {id: agentId}, data: {lastActiveAt: new Date(Math.min(at, now))}});
}

console.log(
	`[showcase] ${Object.keys(connectionIds).length} connections, ${Object.keys(agentIds).length} agents, ${Object.keys(personaIds).length} personas, ${story.threads.length} threads, ${taskCount} agent tasks and ${entryCount} activity entries for ${email} in ${orgName}.`,
);

// ---- Signing in, locally -------------------------------------------------------------------------

if (local) {
	const authSecret = process.env.AUTH_SECRET;
	if (authSecret) {
		const token = randomBytes(32).toString('hex');
		must(await createVerificationToken({identifier: email, token: hashVerificationToken(token, authSecret), expires: new Date(now + DAY)}));
		const apiUrl = process.env.VITE_PROXY_API_URL ?? 'http://localhost:4000';
		const query = new URLSearchParams({token, email, callbackUrl: `/${slug}/chat`});
		console.log(`[showcase] Sign in, once, within 24 hours: ${apiUrl}/auth/email/verify?${query}`);
	}
}
await disconnectDb();
