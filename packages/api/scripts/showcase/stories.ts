// The showcase's story: Konsti building Shuttle inside Shuttle, with an on-call persona that reads
// production alerts, one that drafts support replies, one shopping for a bike and one booking
// flights home for Christmas. Everything here is made up; times are relative to when it is seeded,
// in San Francisco's time.
import {type AgentTask, type ChatAlert, sh, type Thread, tool} from './kit';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
// San Francisco in November and December: Pacific Standard Time.
const PST_OFFSET = -8 * HOUR;
export const TIME_ZONE = 'America/Los_Angeles';

export const REPO = 'personalagentproxy/proxy';

/** What the workspace is renamed to, and its address. */
export const WORKSPACE = {name: 'Shuttle', slug: 'shuttle'};

/** Konsti's cofounder, the workspace's other member. */
export const ARNE = {email: 'arne@midrender.com', name: 'Arne', daysAgo: 21};

/**
 * The connections the showcase makes, each with its account and the actions agents get by default:
 * Konsti's, unless `owner` says Arne's; his alone, unless `share` says with everyone, as the team's
 * tools are, or with Konsti by name.
 */
export const CONNECTIONS = {
	google: {
		integrationId: 'google',
		account: 'konsti@midrender.com',
		daysAgo: 24,
		defaults: ['readEmails', 'markEmails', 'labelEmails', 'archiveEmails', 'writeEmails', 'readEvents', 'readAvailability', 'writeEvents', 'inviteGuests', 'readFiles', 'readContacts'],
	},
	// Arne's calendar, shared with Konsti so his agents can find a time: when he is busy, nothing more.
	arneCalendar: {
		integrationId: 'google',
		account: 'arne@midrender.com',
		owner: 'arne',
		share: 'konsti',
		daysAgo: 20,
		defaults: ['readAvailability'],
	},
	support: {
		integrationId: 'email',
		account: 'support@shuttleoutcomes.com',
		daysAgo: 21,
		share: 'everyone',
		// Triage and drafts; nothing goes out without a person.
		defaults: ['read', 'mark', 'flag', 'archive', 'write'],
	},
	github: {
		integrationId: 'github',
		account: 'hkonsti',
		// The team's, so Devin, the team's agent, reaches it; what it pushes shows as hkonsti's.
		share: 'everyone',
		daysAgo: 24,
		// Branches and pull requests, never the default branch, never a merge.
		defaults: ['read', 'push', 'contribute'],
	},
	linear: {
		integrationId: 'linear',
		account: 'konsti@midrender.com · Shuttle',
		share: 'everyone',
		daysAgo: 23,
		defaults: ['read', 'create', 'edit'],
	},
	notion: {
		integrationId: 'notion',
		account: 'konsti@midrender.com · Shuttle',
		share: 'everyone',
		daysAgo: 23,
		defaults: ['read', 'create'],
	},
	granola: {
		integrationId: 'granola',
		account: 'konsti@midrender.com',
		daysAgo: 22,
		defaults: ['readNotes', 'readTranscripts'],
	},
	observability: {
		integrationId: 'mcp',
		account: 'admin.shuttleoutcomes.com/mcp',
		name: 'Shuttle observability',
		share: 'everyone',
		daysAgo: 20,
		defaults: ['query_logs', 'list_log_labels', 'query_metrics', 'list_metrics', 'query_database', 'list_tables'],
	},
	plaid: {
		integrationId: 'plaid',
		account: 'Chase',
		daysAgo: 18,
		defaults: ['readBalances', 'readTransactions'],
	},
	exa: {
		integrationId: 'exa',
		account: 'Exa',
		daysAgo: 16,
		defaults: ['search', 'fetch'],
	},
} as const satisfies Record<string, ConnectionSpec>;

export type ConnectionSpec = {integrationId: string; account: string; name?: string; owner?: 'arne'; share?: 'everyone' | 'konsti'; daysAgo: number; defaults: readonly string[]};

/** The observability server's tools, as it lists them. */
export const OBSERVABILITY_TOOLS = [
	{
		name: 'query_logs',
		title: 'Query logs',
		description: 'Lines of Shuttle’s log matching a LogQL query, newest first, with their time and labels.',
		props: {query: 'LogQL, such as {service="api"} |= "error"', since: 'How far back, such as 1h', limit: 'At most this many lines'},
	},
	{
		name: 'list_log_labels',
		title: 'List log labels',
		description: 'The log’s stream labels, or the values one of them takes, within a window.',
		props: {label: 'A label, for its values', since: 'How far back'},
	},
	{
		name: 'query_metrics',
		title: 'Query metrics',
		description: 'Shuttle’s metrics by a PromQL query: each series over a window, or at this moment.',
		props: {query: 'PromQL', since: 'How far back', step: 'Resolution, such as 1m'},
	},
	{
		name: 'list_metrics',
		title: 'List metrics',
		description: 'The names of every metric there is, or those containing a word, with their help text.',
		props: {match: 'A word the name contains'},
	},
	{
		name: 'query_database',
		title: 'Query the database',
		description: 'One read-only SQL statement against Shuttle’s production database, with a 10-second limit, answered as its rows.',
		props: {sql: 'SELECT, WITH, EXPLAIN, SHOW, TABLE or VALUES'},
	},
	{
		name: 'list_tables',
		title: 'List tables',
		description: 'Every table of the production database with its columns and their types, or one table’s.',
		props: {table: 'A table, for its columns'},
	},
];

/** The personas, beside General: Konsti's own, or the team's, which every member sees, each in a chat of their own. */
export const PERSONAS = {
	engineer: {name: 'Engineer', color: 'purple', harness: 'claude-agent-sdk', chatModel: 'opus'},
	oncall: {name: 'On-call', color: 'orange', harness: 'claude-agent-sdk', chatModel: 'opus', shared: true},
	support: {name: 'Support', color: 'green', harness: 'claude-agent-sdk', chatModel: 'sonnet', shared: true},
	shopping: {name: 'Shopping', color: 'yellow', harness: 'claude-agent-sdk', chatModel: 'sonnet'},
	travel: {name: 'Travel', color: 'teal', harness: 'claude-agent-sdk', chatModel: 'sonnet'},
} as const;

/**
 * The outside agents' logins, each with its own settings beside the connections' defaults: Konsti's,
 * or, `shared`, the team's, which reaches only what is shared with everyone and whose work everyone sees.
 */
export const AGENTS = {
	claudeCode: {
		providerId: 'claude-code',
		name: 'Claude Code',
		username: 'claude-code-r4mz',
		daysAgo: 22,
		grants: {google: {readEmails: false}},
	},
	devin: {
		providerId: 'devin',
		name: 'Devin',
		username: 'devin-q8wd',
		daysAgo: 15,
		shared: true,
		grants: {support: {read: false}},
	},
	claude: {
		providerId: 'claude',
		name: 'Claude',
		username: 'claude-k2vt',
		daysAgo: 24,
		grants: {plaid: {readTransactions: false}},
	},
	chatgpt: {
		providerId: 'chatgpt',
		name: 'ChatGPT',
		username: 'chatgpt-h7nc',
		daysAgo: 12,
		grants: {google: {readEmails: false}, support: {read: false}, github: {read: false, push: false, contribute: false}},
	},
} as const;

/** The sandboxes the Engineer and On-call personas work in, asleep. */
export const SANDBOXES = ['shuttle-outlook', 'shuttle-review', 'shuttle-hotfix'];

/** The team's vault, shared with everyone, and its entries. */
export const HANDBOOK = {
	name: 'Shuttle handbook',
	entries: [
		{title: 'How Shuttle writes', type: 'Text', content: 'Short sentences. Say what happened, then what we did. Sign off as “Konsti, Shuttle” or “Arne, Shuttle”.'},
		{title: 'Office', type: 'Address', content: 'Shuttle\n2261 Market Street #4\nSan Francisco, CA 94114\nUnited States'},
		{title: 'Deploys', type: 'Text', content: 'main deploys to Render on merge; migrations run as it starts. Roll back from Render’s dashboard. Nobody pushes to main by hand.'},
		{title: 'Support hours', type: 'Text', content: 'Answer within one working day. Refunds: Arne decides; up to one month’s plan without asking.'},
	],
};

/** Konsti's own vault entries. */
export const VAULT_ENTRIES = [
	{title: 'Home in Germany', type: 'Address', content: 'Konstantin Hohr\nc/o Hohr\nSchweizer Straße 41\n60594 Frankfurt am Main\nGermany'},
	{title: 'Miles & More', type: 'Text', content: 'Member number 9922 0071 4417\nStatus: Frequent Traveller'},
	{title: 'Flights', type: 'Text', content: 'Aisle seat, front of the plane. Nonstop over cheaper. Lufthansa or United, for the miles.'},
	{title: 'Bike fit', type: 'Text', content: 'Height 186 cm, inseam 89 cm. Rides a 58 or an L.'},
];

export function stories(now: number) {
	const ago = (hours: number) => new Date(now - hours * HOUR);
	// The last time it was hh:mm in San Francisco, at least `minHoursAgo` ago.
	const lastAt = (hour: number, minute: number, minHoursAgo = 0) => {
		const local = new Date(now + PST_OFFSET);
		let at = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), hour, minute) - PST_OFFSET;
		while (at > now - minHoursAgo * HOUR) {
			at -= DAY;
		}
		return new Date(at);
	};
	// The next weekday at hh:mm in San Francisco.
	const nextWeekdayAt = (hour: number, minute: number) => {
		let at = lastAt(hour, minute).getTime() + DAY;
		while ([0, 6].includes(new Date(at + PST_OFFSET).getUTCDay())) {
			at += DAY;
		}
		return new Date(at);
	};
	const pst = (iso: string) => new Date(`${iso}-08:00`);

	const healthCheckAt = lastAt(8, 0, 1);
	const granolaAt = ago(74);
	const sandboxAt = ago(2.1);
	// A time as San Francisco's clock reads it, `plus` minutes on.
	const clock = (at: Date, plus = 0) => {
		const local = new Date(at.getTime() + plus * 60 * 1000 + PST_OFFSET);
		return `${String(local.getUTCHours()).padStart(2, '0')}:${String(local.getUTCMinutes()).padStart(2, '0')}`;
	};

	const alerts: ChatAlert[] = [
		{
			key: 'production',
			persona: 'oncall',
			setIn: 'Look into production alerts',
			title: 'Production alerts',
			brief:
				'Look into the firing alert: logs, metrics and the deploys around it. Say what happened, whether users noticed, and whether anything needs doing. File an issue where it should not page again.',
			kind: 'watch',
			collection: 'emails',
			on: ['google'],
			terms: ['alerts@shuttleoutcomes.com', '[FIRING'],
			split: 'per_record',
		},
		{
			key: 'morning',
			persona: 'oncall',
			setIn: 'Look into production alerts',
			title: 'Morning health check',
			brief: 'Summarize the last 24 hours of production against the week: requests, 5xx rate, p95 of /mcp, sign-ups, sandboxes woken. Lead with whether anything needs Konsti. Keep it short.',
			kind: 'timed',
			at: nextWeekdayAt(8, 0),
			every: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=8;BYMINUTE=0',
			timeZone: TIME_ZONE,
		},
		{
			key: 'support',
			persona: 'support',
			setIn: 'Answer support emails',
			title: 'Support inbox',
			brief:
				'A new email to support@. Work out what they need; check the logs or the database where it helps. Draft a reply in how Shuttle writes (the Shuttle handbook has it), as a draft, never sent. File a Linear issue for a real bug. Tell Konsti what you found and what the draft says.',
			kind: 'watch',
			collection: 'emails',
			on: ['support'],
			terms: [],
			split: 'per_record',
		},
	];

	const threads: Thread[] = [
		// ---- Engineer --------------------------------------------------------------------------
		{
			persona: 'engineer',
			title: 'Rename Personal Agent Proxy to Shuttle in the app',
			start: ago(6 * 24 + 3),
			summary: 'PR #418 renames the product to Shuttle everywhere a person reads it; package names left as they are.',
			steps: [
				{at: 0, person: `We're Shuttle now. Rename "Personal Agent Proxy" to Shuttle everywhere a person reads it: the web app, the emails we send, the docs and the desktop app. Open a PR.`},
				{
					at: 0.4,
					script: `const sb = await pap.call(sandboxes, 'create', {name: 'shuttle-review'});\nawait pap.call(sandboxes, 'exec', {sandbox: sb.id, pap: true, command: 'pap git clone ${REPO} ~/proxy && cd ~/proxy && bun install'});`,
					result: `{"sandbox":"shuttle-review","exit":0,"stdout":"Cloning into '/home/user/proxy'...\\nbun install v1.3.2\\n 1026 packages installed [11.84s]"}`,
					acts: [
						{on: 'sandboxes', collection: 'sandboxes', action: 'create', title: 'shuttle-review', ms: 9400},
						{on: 'github', collection: 'git', action: 'read', title: REPO, ms: 2100},
						sh('shuttle-review', 'pap git clone personalagentproxy/proxy ~/proxy && cd ~/proxy && bun install', 16400),
					],
				},
				{
					at: 1.6,
					script: `return await pap.call(sandboxes, 'exec', {sandbox, command: "cd ~/proxy && rg -il 'personal agent proxy' --glob '!**/*.test.*' | sed 's|/[^/]*$||' | sort | uniq -c | sort -rn | head -20"});`,
					result: `{"exit":0,"stdout":"  21 packages/web/src/pages\\n  14 packages/docs/content\\n   9 packages/api/src/auth\\n   7 packages/website/src\\n   5 packages/desktop/src\\n   3 packages/api/src/orgs\\n   2 packages/integrations/src"}`,
					acts: [
						sh('shuttle-review', `cd ~/proxy && rg -il 'personal agent proxy' --glob '!**/*.test.*' | sed 's|/[^/]*$||' | sort | uniq -c | sort -rn | head -20`, 900),
						sh('shuttle-review', `cd ~/proxy && rg -c 'Personal Agent Proxy' | awk -F: '{s+=$2} END {print s}'`, 700),
						sh('shuttle-review', `cd ~/proxy && rg -n '@proxy/' package.json packages/*/package.json | head`, 600),
					],
				},
				{
					at: 3.2,
					answer: `It's in 61 files, 214 places. Before I change them: the package names are \`@proxy/*\` and the MCP server's tool descriptions say "Personal Agent Proxy" to agents.\n\nShould I rename the packages too, and the text agents read, or only what a person reads?`,
				},
				{at: 9.5, person: `Only what a person reads, and what agents read. Leave the packages alone.`},
				{
					at: 10,
					script: `// Every string a person or an agent reads; package names and imports left out.\nreturn await pap.call(sandboxes, 'exec', {sandbox, command: "cd ~/proxy && bun scripts/rename-product.ts --from 'Personal Agent Proxy' --to 'Shuttle' --skip-imports"});`,
					result: `{"exit":0,"stdout":"Rewrote 203 strings in 58 files. Skipped 11 in imports and package names."}`,
					acts: [
						sh('shuttle-review', `cd ~/proxy && bun scripts/rename-product.ts --from 'Personal Agent Proxy' --to 'Shuttle' --skip-imports`, 2400),
						sh('shuttle-review', 'cd ~/proxy && git diff --stat | tail -1', 500),
					],
				},
				{
					at: 12.5,
					script: `return await pap.call(sandboxes, 'exec', {sandbox, command: 'cd ~/proxy && bun run typecheck && bun run test 2>&1 | tail -5'});`,
					result: `{"exit":1,"stdout":"(fail) welcome page > names the product [3.02ms]\\n  Expected: \\"Welcome to Personal Agent Proxy\\"\\n  Received: \\"Welcome to Shuttle\\"\\n 2318 pass\\n 4 fail"}`,
					acts: [sh('shuttle-review', 'cd ~/proxy && bun run typecheck && bun run test 2>&1 | tail -5', 98000)],
				},
				{
					at: 15,
					say: `Four tests still expect the old name; updating them.`,
					script: `return await pap.call(sandboxes, 'exec', {sandbox, command: "cd ~/proxy && rg -l 'Personal Agent Proxy' -g '*.test.*' | xargs sed -i 's/Personal Agent Proxy/Shuttle/g' && bun run test 2>&1 | tail -2"});`,
					result: `{"exit":0,"stdout":" 2322 pass\\n 0 fail"}`,
					acts: [sh('shuttle-review', `cd ~/proxy && rg -l 'Personal Agent Proxy' -g '*.test.*' | xargs sed -i 's/Personal Agent Proxy/Shuttle/g' && bun run test 2>&1 | tail -2`, 96000)],
				},
				{
					at: 18,
					script: `await pap.call(sandboxes, 'exec', {sandbox, pap: true, command: 'cd ~/proxy && git checkout -b rename-to-shuttle && git commit -qam "call the product Shuttle wherever a person or an agent reads it" && pap git push -u origin rename-to-shuttle'});\nreturn await pap.call(sandboxes, 'exec', {sandbox, pap: true, command: 'cd ~/proxy && pap gh pr create --fill --base main'});`,
					result: `{"exit":0,"stdout":"https://github.com/personalagentproxy/proxy/pull/418"}`,
					acts: [
						sh(
							'shuttle-review',
							'cd ~/proxy && git checkout -b rename-to-shuttle && git commit -qam "call the product Shuttle wherever a person or an agent reads it" && pap git push -u origin rename-to-shuttle',
							5200,
						),
						{on: 'github', collection: 'git', action: 'push', title: REPO, query: 'rename-to-shuttle', ms: 1400},
						sh('shuttle-review', 'cd ~/proxy && pap gh pr create --fill --base main', 3100),
						{on: 'github', collection: 'api', action: 'contribute', query: 'POST /graphql mutation CreatePullRequest', ms: 1300},
					],
				},
				{
					at: 19.5,
					answer: `**#418 is open:** Shuttle everywhere a person or an agent reads it.\n\n- 203 strings in 58 files: the web app, sign-in and invite emails, the docs, the website, the desktop app's menus, and the MCP server's tool descriptions.\n- \`@proxy/*\` packages and imports untouched.\n- Four tests asserted the old name; updated. 2,322 pass, typecheck clean.\n\nThe favicon still says PAP. That's an image, so it's yours or a designer's.`,
				},
			],
		},
		{
			persona: 'engineer',
			title: 'Outlook calendar connection',
			start: ago(50),
			summary: 'PR #431 adds Outlook calendar as a connection; tests pass, ready for review.',
			steps: [
				{
					at: 0,
					person: `Add Outlook calendar as a connection, the same shape as the Google calendar one: read events, create and edit them, answer invitations. Work in a sandbox and open a PR when the tests pass.`,
				},
				{
					at: 0.3,
					script: `const sb = await pap.call(sandboxes, 'create', {name: 'shuttle-outlook'});\nreturn await pap.call(sandboxes, 'exec', {sandbox: sb.id, pap: true, command: 'pap git clone ${REPO} ~/proxy && cd ~/proxy && bun install && rg -l calendar packages/api/src/connections/google'});`,
					result: `{"exit":0,"stdout":"packages/api/src/connections/google/calendar.ts\\npackages/api/src/connections/google/calendar.test.ts\\npackages/api/src/connections/google/events-connector.ts\\npackages/api/src/connections/google/availability.ts"}`,
					acts: [
						{on: 'sandboxes', collection: 'sandboxes', action: 'create', title: 'shuttle-outlook', ms: 8800},
						{on: 'github', collection: 'git', action: 'read', title: REPO, ms: 1900},
						sh('shuttle-outlook', 'pap git clone personalagentproxy/proxy ~/proxy && cd ~/proxy && bun install && rg -l calendar packages/api/src/connections/google', 17200),
					],
				},
				{
					at: 2,
					say: `Splitting this in two: one sub-agent maps how Google's calendar is wired, another writes the Microsoft Graph client. I'll do the catalog entry meanwhile.`,
					subAgents: [
						{
							title: 'Map the Google calendar connection',
							brief: `In the sandbox shuttle-outlook, ~/proxy: read how the Google calendar is wired end to end, from the catalog entry (packages/integrations) to the connector, its permissions and its watch for alerts. Report every file an Outlook calendar needs its own of, and what each does, in a short list.`,
							steps: [
								{
									at: 0.4,
									script: `return await pap.call(sandboxes, 'exec', {sandbox, command: "cd ~/proxy && rg -n \\"'events'\\" packages/integrations/src/catalog.ts packages/api/src/connections/google | head -30"});`,
									result: `{"exit":0,"stdout":"packages/integrations/src/catalog.ts:1288:\\t\\t\\tid: 'events',\\npackages/api/src/connections/google/events-connector.ts:41:export const eventsConnector ..."}`,
									acts: [
										sh('shuttle-outlook', `cd ~/proxy && rg -n "'events'" packages/integrations/src/catalog.ts packages/api/src/connections/google | head -30`, 700),
										sh('shuttle-outlook', 'cd ~/proxy && sed -n 1,120p packages/api/src/connections/google/events-connector.ts', 400),
										sh('shuttle-outlook', 'cd ~/proxy && sed -n 1,80p packages/api/src/connections/google/availability.ts', 400),
										sh('shuttle-outlook', 'cd ~/proxy && rg -n "changes" packages/api/src/connections/google/events-connector.ts', 500),
									],
								},
								{
									at: 5.5,
									answer: `Six pieces, each needs an Outlook twin:\n\n1. **Catalog entry** (\`integrations/src/catalog.ts\`): the actions readEvents, writeEvents, respondEvents, readAvailability, and the events and availability collections.\n2. **Sign-in** (\`connections/google/google-oauth.ts\`): OAuth with refresh; Microsoft's is the same shape, other endpoints.\n3. **Events connector** (\`events-connector.ts\`): list, view, create, update, and the accept/decline/maybe commands.\n4. **Availability** (\`availability.ts\`): free/busy over a window.\n5. **Changes for watches** (\`events-connector.ts\` \`changes\`): Google uses sync tokens; Graph has delta links.\n6. **Tests** beside each.`,
								},
							],
						},
						{
							title: 'Write the Microsoft Graph client',
							brief: `In the sandbox shuttle-outlook, ~/proxy: write packages/api/src/connections/outlook/graph-client.ts, a small client for Microsoft Graph's calendar API: list events in a window, get one, create, update, accept/decline/tentatively accept, getSchedule for free/busy, and delta queries for what changed. Use ts-results-es Results, no throws. Write tests against recorded responses. Report what you wrote and whether the tests pass.`,
							steps: [
								{
									at: 0.5,
									script: `const docs = await pap.call(exa, 'web_search_exa', {query: 'Microsoft Graph calendar delta query events deltaLink expiry'});\nreturn docs.results.slice(0, 3).map(r => r.url);`,
									result: `["https://learn.microsoft.com/en-us/graph/api/event-delta","https://learn.microsoft.com/en-us/graph/delta-query-events","https://learn.microsoft.com/en-us/graph/api/calendar-getschedule"]`,
									acts: [
										{on: 'exa', collection: 'searches', action: 'run', title: 'Microsoft Graph calendar delta query events deltaLink expiry', ms: 1900},
										{on: 'exa', collection: 'pages', action: 'read', title: 'https://learn.microsoft.com/en-us/graph/delta-query-events', ms: 1300},
										{on: 'exa', collection: 'pages', action: 'read', title: 'https://learn.microsoft.com/en-us/graph/api/calendar-getschedule', ms: 1100},
									],
								},
								{
									at: 4,
									script: `return await pap.call(sandboxes, 'exec', {sandbox, command: 'cd ~/proxy && bun test packages/api/src/connections/outlook 2>&1 | tail -3'});`,
									result: `{"exit":0,"stdout":" 14 pass\\n 0 fail\\nRan 14 tests across 1 file. [212.00ms]"}`,
									acts: [
										sh('shuttle-outlook', 'cd ~/proxy && mkdir -p packages/api/src/connections/outlook && cat > packages/api/src/connections/outlook/graph-client.ts', 300),
										sh('shuttle-outlook', 'cd ~/proxy && cat > packages/api/src/connections/outlook/graph-client.test.ts', 300),
										sh('shuttle-outlook', 'cd ~/proxy && bun test packages/api/src/connections/outlook 2>&1 | tail -3', 4100),
										sh('shuttle-outlook', 'cd ~/proxy && bun run --cwd packages/api typecheck', 21000),
									],
								},
								{
									at: 12.5,
									answer: `Wrote \`connections/outlook/graph-client.ts\` (290 lines) and its tests: events in a window, one event, create, update, accept/decline/tentative, getSchedule, and delta.\n\n14 tests pass, typecheck clean. One thing to know: a delta link expires after about 7 days without a sync. The client answers \`expired\` then, and the caller starts a full sync again.`,
								},
							],
						},
					],
				},
				{
					at: 3,
					script: `return await pap.call(sandboxes, 'exec', {sandbox, command: 'cd ~/proxy && cp -r packages/api/src/connections/google/events-connector.ts packages/api/src/connections/outlook/ && $EDITOR_PATCH outlook-catalog.patch'});`,
					result: `{"exit":0,"stdout":"patched packages/integrations/src/catalog.ts\\npatched packages/api/src/connections/integrations.ts"}`,
					acts: [
						sh('shuttle-outlook', 'cd ~/proxy && sed -n 1270,1340p packages/integrations/src/catalog.ts', 400),
						sh('shuttle-outlook', 'cd ~/proxy && git apply outlook-catalog.patch && git status --short', 600),
					],
				},
				{at: 8, report: 'Map the Google calendar connection'},
				{at: 9, tell: `Halfway: the catalog entry and sign-in are in, the Graph client is being written beside me. Next the connector and the watch.`},
				{
					at: 9.2,
					script: `return await pap.call(sandboxes, 'exec', {sandbox, command: 'cd ~/proxy && bun test packages/api/src/connections/outlook packages/integrations 2>&1 | tail -3'});`,
					result: `{"exit":0,"stdout":" 61 pass\\n 0 fail"}`,
					acts: [
						sh('shuttle-outlook', 'cd ~/proxy && cat > packages/api/src/connections/outlook/events-connector.ts', 300),
						sh('shuttle-outlook', 'cd ~/proxy && cat > packages/api/src/connections/outlook/outlook-oauth.ts', 300),
						sh('shuttle-outlook', 'cd ~/proxy && bun test packages/api/src/connections/outlook packages/integrations 2>&1 | tail -3', 6200),
					],
				},
				{at: 15, report: 'Write the Microsoft Graph client'},
				{
					at: 15.5,
					script: `return await pap.call(sandboxes, 'exec', {sandbox, command: 'cd ~/proxy && bun run typecheck && bun run test 2>&1 | tail -2'});`,
					result: `{"exit":0,"stdout":" 2396 pass\\n 0 fail"}`,
					acts: [sh('shuttle-outlook', 'cd ~/proxy && bun run typecheck && bun run test 2>&1 | tail -2', 104000)],
				},
				{
					at: 18,
					script: `await pap.call(sandboxes, 'exec', {sandbox, pap: true, command: 'cd ~/proxy && git checkout -b outlook-calendar && git add -A && git commit -qm "connect an Outlook calendar, as a Google one is" && pap git push -u origin outlook-calendar'});\nreturn await pap.call(sandboxes, 'exec', {sandbox, pap: true, command: 'cd ~/proxy && pap gh pr create --fill --base main'});`,
					result: `{"exit":0,"stdout":"https://github.com/personalagentproxy/proxy/pull/431"}`,
					acts: [
						sh(
							'shuttle-outlook',
							'cd ~/proxy && git checkout -b outlook-calendar && git add -A && git commit -qm "connect an Outlook calendar, as a Google one is" && pap git push -u origin outlook-calendar',
							4800,
						),
						{on: 'github', collection: 'git', action: 'push', title: REPO, query: 'outlook-calendar', ms: 1500},
						sh('shuttle-outlook', 'cd ~/proxy && pap gh pr create --fill --base main', 2900),
						{on: 'github', collection: 'api', action: 'contribute', query: 'POST /graphql mutation CreatePullRequest', ms: 1200},
						{on: 'sandboxes', collection: 'sandboxes', action: 'sleep', title: 'shuttle-outlook', ms: 2300},
					],
				},
				{
					at: 19.5,
					answer: `**#431 is open:** Outlook calendar as a connection.\n\n- **Actions:** read events, create and edit them, answer invitations, check availability, each its own permission as Google's are.\n- **Watches:** alerts can watch Outlook events, through Graph's delta queries.\n- **Tests:** 2,396 pass, typecheck clean.\n\nOne decision before you merge: Microsoft's delta links expire after about 7 days without a sync, so after a quiet week a watch starts over with a full sync. I made that silent. Say if you'd rather it showed on the connection page.`,
				},
			],
		},
		{
			persona: 'engineer',
			title: 'Thread titles cut mid-word',
			start: ago(27),
			summary: 'PR #429 cuts thread titles at a word; merging is left to Konsti.',
			steps: [
				{at: 0, person: `Thread titles in the sidebar get cut mid-word, like "Prepare the board upd…". Cut them at the last whole word instead.`},
				{
					at: 0.3,
					script: `await pap.call(sandboxes, 'wake', {name: 'shuttle-review'});\nreturn await pap.call(sandboxes, 'exec', {sandbox, command: "cd ~/proxy && git pull -q && rg -n 'cut\\\\(' packages/utils/src/harness.ts packages/api/src/harness/thread-title.ts"});`,
					result: `{"exit":0,"stdout":"packages/utils/src/harness.ts:23:export function cut(text: string, max: number): string {\\npackages/api/src/harness/thread-title.ts:52:\\treturn cut(folded(title), MAX_THREAD_TITLE);"}`,
					acts: [
						{on: 'sandboxes', collection: 'sandboxes', action: 'wake', title: 'shuttle-review', ms: 6100},
						{on: 'github', collection: 'git', action: 'read', title: REPO, ms: 800},
						sh('shuttle-review', `cd ~/proxy && git pull -q && rg -n 'cut\\(' packages/utils/src/harness.ts packages/api/src/harness/thread-title.ts`, 2600),
					],
				},
				{
					at: 3,
					script: `return await pap.call(sandboxes, 'exec', {sandbox, command: 'cd ~/proxy && git apply cut-at-word.patch && bun test packages/utils packages/api/src/harness/thread-title.test.ts 2>&1 | tail -2'});`,
					result: `{"exit":0,"stdout":" 187 pass\\n 0 fail"}`,
					acts: [sh('shuttle-review', 'cd ~/proxy && git apply cut-at-word.patch && bun test packages/utils packages/api/src/harness/thread-title.test.ts 2>&1 | tail -2', 7400)],
				},
				{
					at: 6,
					script: `await pap.call(sandboxes, 'exec', {sandbox, pap: true, command: 'cd ~/proxy && git checkout -qb title-cut-at-word && git commit -qam "cut a thread title at its last whole word" && pap git push -u origin title-cut-at-word && pap gh pr create --fill'});`,
					result: `{"exit":0,"stdout":"https://github.com/personalagentproxy/proxy/pull/429"}`,
					acts: [
						sh(
							'shuttle-review',
							'cd ~/proxy && git checkout -qb title-cut-at-word && git commit -qam "cut a thread title at its last whole word" && pap git push -u origin title-cut-at-word && pap gh pr create --fill',
							6900,
						),
						{on: 'github', collection: 'git', action: 'push', title: REPO, query: 'title-cut-at-word', ms: 1300},
						{on: 'github', collection: 'api', action: 'contribute', query: 'POST /graphql mutation CreatePullRequest', ms: 1100},
					],
				},
				{
					at: 7,
					answer: `Fixed in **#429**: a title is now cut at its last whole word before the limit, so "Prepare the board upd…" becomes "Prepare the board…". A single word longer than the limit is still cut inside it.\n\nThree tests added. It's a five-line change, so I left merging to you.`,
				},
			],
		},
		{
			persona: 'engineer',
			title: 'Review Devin’s PR #433',
			start: ago(3.4),
			waiting: true,
			summary: 'Found a race in #433; waiting on whether to fix it on Devin’s branch or leave a review.',
			steps: [
				{at: 0, person: `Devin opened #433 for SHU-221, the sandbox list flickering on wake. Review it, and check it against what users actually hit in the logs.`},
				{
					at: 0.3,
					script: `const pr = await pap.call(github, 'pull_request', {repo: '${REPO}', number: 433});\nawait pap.call(sandboxes, 'wake', {name: 'shuttle-review'});\nreturn await pap.call(sandboxes, 'exec', {sandbox, pap: true, command: 'cd ~/proxy && git fetch -q origin pull/433/head:pr-433 && git diff main...pr-433 --stat'});`,
					result: `{"exit":0,"stdout":" packages/web/src/pages/connection-page.tsx      | 18 ++++++++------\\n packages/web/src/hooks/use-sandboxes.ts        | 31 +++++++++++++++++-------\\n packages/web/src/hooks/use-sandboxes.test.ts   | 44 ++++++++++++++++++++++++++++++++++\\n 3 files changed, 72 insertions(+), 21 deletions(-)"}`,
					acts: [
						{on: 'github', collection: 'api', action: 'read', query: 'POST /graphql query PullRequestByNumber', ms: 430},
						{on: 'linear', collection: 'issues', action: 'view', title: 'SHU-221', ms: 610},
						{on: 'sandboxes', collection: 'sandboxes', action: 'wake', title: 'shuttle-review', ms: 5800},
						sh('shuttle-review', 'cd ~/proxy && git fetch -q origin pull/433/head:pr-433 && git diff main...pr-433 --stat', 2900),
						sh('shuttle-review', 'cd ~/proxy && git diff main...pr-433 -- packages/web/src/hooks/use-sandboxes.ts', 500),
					],
				},
				{
					at: 3.5,
					script: `return await pap.call(observability, 'query_logs', {query: '{service="api"} |= "sandbox" |~ "wake"', since: '7d', limit: 200});`,
					result: `{"lines":200,"note":"38 wakes answered after the list was read again; 6 of them while a second wake was asked for the same sandbox"}`,
					acts: [
						tool('query_logs', {query: '{service="api"} |= "sandbox" |~ "wake"', since: '7d', limit: 200}, 2100),
						tool('query_metrics', {query: 'histogram_quantile(0.95, sum by (le) (rate(sandbox_wake_seconds_bucket[1h])))', since: '7d', step: '1h'}, 900),
					],
				},
				{
					at: 6,
					script: `return await pap.call(sandboxes, 'exec', {sandbox, command: 'cd ~/proxy && git checkout -q pr-433 && bun test packages/web/src/hooks/use-sandboxes.test.ts 2>&1 | tail -2'});`,
					result: `{"exit":0,"stdout":" 9 pass\\n 0 fail"}`,
					acts: [
						sh('shuttle-review', 'cd ~/proxy && git checkout -q pr-433 && bun test packages/web/src/hooks/use-sandboxes.test.ts 2>&1 | tail -2', 3800),
						sh('shuttle-review', 'cd ~/proxy && cat > /tmp/double-wake.test.ts && bun test /tmp/double-wake.test.ts 2>&1 | tail -4', 3100),
					],
				},
				{
					at: 9,
					answer: `Reviewed **#433**. The fix is right for the common case: the list no longer refetches while a wake is pending, so the row stops flickering. Its 9 tests pass.\n\nBut there's a race the logs show users hitting: **6 times this week** someone clicked Wake twice. The second wake's answer clears the pending flag while the first is still running, and the row flips back to Asleep for 2–3 s. I wrote a test that reproduces it on the branch.\n\nTwo ways to go:\n1. **I push the fix to Devin's branch:** keep a count of pending wakes per sandbox instead of a flag. About 15 lines and my test.\n2. **I leave it as a review comment** and Devin picks it up.\n\nWhich do you want?`,
				},
			],
		},
		// ---- On-call ---------------------------------------------------------------------------
		{
			persona: 'oncall',
			title: 'Look into production alerts',
			start: ago(9 * 24 + 5),
			summary: 'Every firing production alert opens its own thread, plus a health check each weekday at 8:00.',
			steps: [
				{
					at: 0,
					person: `Whenever Grafana emails a firing alert, look into it: logs, metrics, recent deploys. Tell me what happened and whether I need to do anything. And every weekday at 8, give me a short health check of the last 24 hours.`,
				},
				{
					at: 0.4,
					script: `const labels = await pap.call(observability, 'list_log_labels', {since: '1d'});\nconst metrics = await pap.call(observability, 'list_metrics', {match: 'http'});\nreturn {labels, metrics: metrics.length};`,
					result: `{"labels":{"service":["api","web","desktop","internal","admin"],"env":["production","development"],"level":["debug","info","warn","error"]},"metrics":14}`,
					acts: [
						tool('list_log_labels', {since: '1d'}, 300),
						tool('list_metrics', {match: 'http'}, 250),
						{on: 'google', collection: 'emails', action: 'list', query: 'from:alerts@shuttleoutcomes.com', ms: 900},
					],
				},
				{
					at: 1.5,
					answer: `Set up two alerts:\n\n- **Production alerts:** each email from alerts@shuttleoutcomes.com that says [FIRING] opens its own thread here. I'll check logs, metrics and deploys, and tell you whether you need to act.\n- **Morning health check:** weekdays at 8:00, the last 24 hours against the week.\n\nBoth are on your Alerts page if you want to change them.`,
				},
			],
		},
		{
			persona: 'oncall',
			title: 'Production alerts: [FIRING:1] api 5xx rate above 2%',
			start: granolaAt,
			opened: {
				alert: 'production',
				change: {
					id: '19a3f2c9d1e04b7a',
					title: '[FIRING:1] api 5xx rate above 2%',
					url: 'https://mail.google.com/mail/u/0/#inbox/19a3f2c9d1e04b7a',
					summary: `Grafana Alerting. api 5xx rate is 3.4% over the last 5m (threshold 2%). Labels: service=api, env=production. Firing since ${clock(granolaAt)} PST`,
				},
			},
			summary: 'Granola’s API was down for 39 minutes; nothing to do. SHU-226 filed so upstream failures stop paging.',
			steps: [
				{
					at: 0.2,
					script: `const rate = await pap.call(observability, 'query_metrics', {query: 'sum(rate(http_requests_total{service="api",status=~"5.."}[5m])) / sum(rate(http_requests_total{service="api"}[5m]))', since: '2h', step: '1m'});\nconst errors = await pap.call(observability, 'query_logs', {query: '{service="api", env="production", level="error"}', since: '30m', limit: 100});\nreturn {rate: rate.series[0].last, top: countBy(errors.lines, l => l.msg).slice(0, 3)};`,
					result: `{"rate":0.034,"top":[["Granola request failed",311],["MCP tool call failed",12],["IMAP search timed out",2]]}`,
					acts: [
						tool('query_metrics', {query: 'sum(rate(http_requests_total{service="api",status=~"5.."}[5m])) / sum(rate(http_requests_total{service="api"}[5m]))', since: '2h', step: '1m'}, 1100),
						tool('query_logs', {query: '{service="api", env="production", level="error"}', since: '30m', limit: 100}, 1600),
					],
				},
				{
					at: 1.5,
					script: `return await pap.call(observability, 'query_logs', {query: '{service="api"} |= "Granola request failed" | json | line_format "{{.status}} {{.route}}"', since: '1h', limit: 40});`,
					result: `{"lines":40,"statuses":{"502":38,"504":2},"routes":{"get_meetings":29,"list_meetings":11}}`,
					acts: [
						tool('query_logs', {query: '{service="api"} |= "Granola request failed" | json | line_format "{{.status}} {{.route}}"', since: '1h', limit: 40}, 900),
						{on: 'exa', collection: 'searches', action: 'run', title: 'Granola API status outage today', ms: 1700},
					],
				},
				{
					at: 40,
					script: `const rate = await pap.call(observability, 'query_metrics', {query: 'sum(rate(http_requests_total{service="api",status=~"5.."}[5m])) / sum(rate(http_requests_total{service="api"}[5m]))', since: '1h', instant: true});\nconst issue = await pap.call(linear, 'save_issue', {team: 'SHU', title: 'Count upstream failures apart from our own 5xx', description: '...'});\nreturn {rate, issue: issue.identifier};`,
					result: `{"rate":0.0011,"issue":"SHU-226"}`,
					acts: [
						tool('query_metrics', {query: 'sum(rate(http_requests_total{service="api",status=~"5.."}[5m])) / sum(rate(http_requests_total{service="api"}[5m]))', since: '1h'}, 700),
						{on: 'linear', collection: 'issues', action: 'create', title: 'Count upstream failures apart from our own 5xx', ms: 1300},
					],
				},
				{
					at: 41,
					answer: `**Granola's API was down, not us.** From ${clock(granolaAt, -4)} to ${clock(granolaAt, 35)}, 311 requests to Granola failed with 502s, almost all \`get_meetings\`. We pass a provider's 502 on as our own 5xx, so the rate crossed 2%.\n\n- **Users:** anyone asking an agent for meeting notes in those 39 minutes got an error. Nothing else was affected.\n- **Now:** recovered on its own at ${clock(granolaAt, 35)}; the 5xx rate is back to 0.11%.\n- **Nothing for you to do.** I filed **SHU-226** to count upstream failures apart from our own errors, so an outage at Granola stops paging you.`,
				},
			],
		},
		{
			persona: 'oncall',
			title: 'Production alerts: [FIRING:1] p95 latency of /mcp above 2s',
			start: ago(32.5),
			opened: {
				alert: 'production',
				change: {
					id: '19a4b8e02f7c31d5',
					title: '[FIRING:1] p95 latency of /mcp above 2s',
					url: 'https://mail.google.com/mail/u/0/#inbox/19a4b8e02f7c31d5',
					summary: 'Grafana Alerting. p95 of POST /mcp is 2.61s over the last 10m (threshold 2s). Labels: service=api, route=/mcp, env=production',
				},
			},
			summary: 'Listing threads seq-scans AgentEntry for one large workspace; PR #430 adds the index. Merge is Konsti’s.',
			steps: [
				{
					at: 0.2,
					script: `const p95 = await pap.call(observability, 'query_metrics', {query: 'histogram_quantile(0.95, sum by (le, tool) (rate(mcp_tool_seconds_bucket[10m])))', since: '6h', step: '5m'});\nreturn p95.series.sort((a, b) => b.last - a.last).slice(0, 3).map(s => [s.labels.tool, s.last]);`,
					result: `[["chat.threads.list",2.94],["script",1.12],["gmail.emails.list",0.81]]`,
					acts: [tool('query_metrics', {query: 'histogram_quantile(0.95, sum by (le, tool) (rate(mcp_tool_seconds_bucket[10m])))', since: '6h', step: '5m'}, 1300)],
				},
				{
					at: 1.5,
					script: `return await pap.call(observability, 'query_database', {sql: 'EXPLAIN ANALYZE SELECT "id","kind","seq" FROM "AgentEntry" WHERE "threadId" = ANY($threads) ORDER BY "seq" DESC LIMIT 1'});`,
					result: `{"plan":"Limit (actual time=2398.112..2398.114) -> Sort -> Seq Scan on \\"AgentEntry\\" (rows=412883) Filter: (\\"threadId\\" = ANY (...))","rows":1}`,
					acts: [
						tool('list_tables', {table: 'AgentEntry'}, 300),
						tool('query_database', {sql: 'SELECT "orgId", count(*) FROM "AgentEntry" JOIN "AgentThread" t ON t.id = "threadId" GROUP BY 1 ORDER BY 2 DESC LIMIT 5'}, 3900),
						tool('query_database', {sql: 'EXPLAIN ANALYZE SELECT "id","kind","seq" FROM "AgentEntry" WHERE "threadId" = ANY($threads) ORDER BY "seq" DESC LIMIT 1'}, 2600),
					],
				},
				{
					at: 4,
					say: `Found it: a missing index. Starting a sub-agent on the migration while I check when it started.`,
					subAgents: [
						{
							title: 'Write the AgentEntry index migration',
							brief: `In the sandbox shuttle-hotfix, clone ${REPO}. Add a migration (packages/db/prisma/migrations, next v-number) creating an index on "AgentEntry" ("threadId", "seq" DESC), CONCURRENTLY, and the @@index in schema.prisma. Run the db tests. Push a branch and open a PR titled "index a thread's entries by seq, newest first". Report the PR's link.`,
							steps: [
								{
									at: 0.3,
									script: `const sb = await pap.call(sandboxes, 'create', {name: 'shuttle-hotfix'});\nreturn await pap.call(sandboxes, 'exec', {sandbox: sb.id, pap: true, command: 'pap git clone ${REPO} ~/proxy && cd ~/proxy && bun install && ls packages/db/prisma/migrations | tail -2'});`,
									result: `{"exit":0,"stdout":"v070_add_thread_model\\nv071_add_sub_agents"}`,
									acts: [
										{on: 'sandboxes', collection: 'sandboxes', action: 'create', title: 'shuttle-hotfix', ms: 9100},
										{on: 'github', collection: 'git', action: 'read', title: REPO, ms: 2000},
										sh('shuttle-hotfix', 'pap git clone personalagentproxy/proxy ~/proxy && cd ~/proxy && bun install && ls packages/db/prisma/migrations | tail -2', 15800),
									],
								},
								{
									at: 3,
									script: `return await pap.call(sandboxes, 'exec', {sandbox, pap: true, command: 'cd ~/proxy && bun test packages/db 2>&1 | tail -2 && git checkout -qb index-entries-by-seq && git commit -qam "index a thread\\'s entries by seq, newest first" && pap git push -u origin index-entries-by-seq && pap gh pr create --fill'});`,
									result: `{"exit":0,"stdout":" 341 pass\\n 0 fail\\nhttps://github.com/personalagentproxy/proxy/pull/430"}`,
									acts: [
										sh(
											'shuttle-hotfix',
											`cd ~/proxy && mkdir packages/db/prisma/migrations/v072_index_entries_by_seq && cat > packages/db/prisma/migrations/v072_index_entries_by_seq/migration.sql`,
											300,
										),
										sh('shuttle-hotfix', 'cd ~/proxy && bun test packages/db 2>&1 | tail -2', 24000),
										sh(
											'shuttle-hotfix',
											`cd ~/proxy && git checkout -qb index-entries-by-seq && git commit -qam "index a thread's entries by seq, newest first" && pap git push -u origin index-entries-by-seq && pap gh pr create --fill`,
											7400,
										),
										{on: 'github', collection: 'git', action: 'push', title: REPO, query: 'index-entries-by-seq', ms: 1400},
										{on: 'github', collection: 'api', action: 'contribute', query: 'POST /graphql mutation CreatePullRequest', ms: 1200},
										{on: 'sandboxes', collection: 'sandboxes', action: 'sleep', title: 'shuttle-hotfix', ms: 2200},
									],
								},
								{
									at: 4.5,
									answer: `PR #430 is open. Migration \`v072_index_entries_by_seq\` creates the index concurrently, so it doesn't lock the table while it builds. db tests: 341 pass.`,
								},
							],
						},
					],
				},
				{
					at: 4.5,
					script: `return await pap.call(observability, 'query_metrics', {query: 'histogram_quantile(0.95, sum by (le) (rate(mcp_tool_seconds_bucket{tool="chat.threads.list"}[1h])))', since: '14d', step: '6h'});`,
					result: `{"series":[{"first":0.38,"last":2.61,"crossed_1s":"3 days ago, 10:00"}]}`,
					acts: [
						tool('query_metrics', {query: 'histogram_quantile(0.95, sum by (le) (rate(mcp_tool_seconds_bucket{tool="chat.threads.list"}[1h])))', since: '14d', step: '6h'}, 1400),
						{on: 'github', collection: 'api', action: 'read', query: 'GET /repos/personalagentproxy/proxy/commits?since=2026-11-14', ms: 520},
					],
				},
				{at: 9.5, report: 'Write the AgentEntry index migration'},
				{
					at: 10,
					answer: `**Cause: a missing index.** Listing a member's threads reads the newest entry of each, and since #345 that query has no index to use, so it scans all of \`AgentEntry\`. It was fine until one workspace passed 400k entries three days ago; p95 went from 0.38s to 2.6s.\n\n- **Users:** slow, not failing. Only the Chat page's thread list and \`chat.threads.list\` over MCP.\n- **Fix:** **#430** adds an index on \`("threadId", "seq" DESC)\`, built concurrently so the table isn't locked. The query plan with it takes 4 ms.\n\nMerging is yours. It's safe to deploy any time.`,
				},
			],
		},
		{
			persona: 'oncall',
			title: 'Morning health check',
			start: healthCheckAt,
			opened: {alert: 'morning'},
			summary: 'Quiet night; nothing needs Konsti.',
			steps: [
				{
					at: 0.1,
					script: `const q = (query) => pap.call(observability, 'query_metrics', {query, since: '7d', step: '1d'});\nconst [requests, errors, p95, signups, wakes] = await Promise.all([q('sum(increase(http_requests_total[1d]))'), q('...5xx ratio...'), q('...p95 /mcp...'), q('sum(increase(signups_total[1d]))'), q('sum(increase(sandbox_wakes_total[1d]))')]);\nreturn {requests, errors, p95, signups, wakes};`,
					result: `{"requests":[1.31e6,1.42e6],"errors":[0.0011,0.0008],"p95":[0.39,0.41],"signups":[29,37],"wakes":[380,412]}`,
					acts: [
						tool('query_metrics', {query: 'sum(increase(http_requests_total{env="production"}[1d]))', since: '7d', step: '1d'}, 600),
						tool(
							'query_metrics',
							{query: 'sum(increase(http_requests_total{env="production",status=~"5.."}[1d])) / sum(increase(http_requests_total{env="production"}[1d]))', since: '7d', step: '1d'},
							700,
						),
						tool('query_metrics', {query: 'histogram_quantile(0.95, sum by (le) (rate(http_request_seconds_bucket{route="/mcp"}[1d])))', since: '7d', step: '1d'}, 800),
						tool('query_metrics', {query: 'sum(increase(signups_total[1d]))', since: '7d', step: '1d'}, 400),
						tool('query_metrics', {query: 'sum(increase(sandbox_wakes_total[1d]))', since: '7d', step: '1d'}, 400),
					],
				},
				{
					at: 1,
					script: `return await pap.call(observability, 'query_logs', {query: '{env="production", level=~"warn|error"}', since: '24h', limit: 200});`,
					result: `{"lines":200,"top":[["IMAP sign-in failed",14],["MCP tool call failed",9],["Granola request failed",3]]}`,
					acts: [tool('query_logs', {query: '{env="production", level=~"warn|error"}', since: '24h', limit: 200}, 2300)],
				},
				{
					at: 1.6,
					answer: `**Quiet night, nothing for you.**\n\n| | Last 24h | Week's average |\n|---|---|---|\n| Requests | 1.42M | 1.31M |\n| 5xx rate | 0.08% | 0.11% |\n| p95 of /mcp | 410 ms | 390 ms |\n| Sign-ups | 37 | 29 |\n| Sandboxes woken | 412 | 380 |\n\nOne thing in the logs: 14 Yahoo mailboxes failed to sign in between 03:10 and 03:25, then recovered. That was Yahoo's IMAP servers, not us.`,
				},
			],
		},
		{
			persona: 'oncall',
			title: 'Production alerts: [FIRING:1] Sandbox wakes failing',
			start: sandboxAt,
			opened: {
				alert: 'production',
				change: {
					id: '19a5c1d77e0b9f42',
					title: '[FIRING:1] Sandbox wakes failing',
					url: 'https://mail.google.com/mail/u/0/#inbox/19a5c1d77e0b9f42',
					summary: 'Grafana Alerting. sandbox wake failure ratio is 70% over the last 15m (threshold 10%). Labels: service=api, backend=remote, env=production',
				},
			},
			waiting: true,
			unread: true,
			summary: 'The sandbox provider is out of capacity in us-west-2; waiting on Konsti to switch regions or wait it out.',
			steps: [
				{
					at: 0.2,
					script: `const wakes = await pap.call(observability, 'query_metrics', {query: 'sum by (outcome) (increase(sandbox_wakes_total[20m]))', since: '1h', step: '5m'});\nconst logs = await pap.call(observability, 'query_logs', {query: '{service="api"} |= "sandbox" |= "wake" | level="error"', since: '30m', limit: 50});\nreturn {wakes, errors: countBy(logs.lines, l => l.error)};`,
					result: `{"wakes":{"ok":13,"failed":31},"errors":{"remote backend: capacity exhausted in us-west-2":31}}`,
					acts: [
						tool('query_metrics', {query: 'sum by (outcome) (increase(sandbox_wakes_total[20m]))', since: '1h', step: '5m'}, 900),
						tool('query_logs', {query: '{service="api"} |= "sandbox" |= "wake" | level="error"', since: '30m', limit: 50}, 1300),
					],
				},
				{
					at: 1.5,
					script: `const status = await pap.call(exa, 'web_fetch_exa', {urls: ['https://status.sandbox-provider.dev']});\nreturn status.results[0].text.slice(0, 400);`,
					result: `"Investigating — Degraded capacity in us-west-2. New and resumed sandboxes in us-west-2 may fail to start. Other regions are not affected. Posted ${clock(sandboxAt)} PST."`,
					acts: [
						{on: 'exa', collection: 'pages', action: 'read', title: 'https://status.sandbox-provider.dev', ms: 1500},
						tool('query_database', {sql: `SELECT count(*) FILTER (WHERE "state" = 'running') AS running, count(*) AS total FROM "Sandbox"`}, 600),
					],
				},
				{
					at: 3,
					answer: `**Sandbox wakes have been failing since ${clock(sandboxAt, -8)}.** Our sandbox provider is out of capacity in **us-west-2**, and their status page confirms it (posted ${clock(sandboxAt)}). 31 of 44 wakes in the last 20 minutes failed; running sandboxes are fine.\n\nUsers who wake a sleeping sandbox see "Couldn't wake the sandbox", and agents' sandbox commands fail.\n\nTwo options:\n1. **Point new sandboxes at us-east-1:** \`SANDBOX_REGION\` on Render. New ones work at once; sleeping ones in us-west-2 still wait for the provider.\n2. **Wait it out** and put a note on the status page.\n\nI can't change Render's settings from here, so 1 is yours to flip. Or tell me to draft the status note.`,
				},
			],
		},
		// ---- Support ---------------------------------------------------------------------------
		{
			persona: 'support',
			title: 'Answer support emails',
			start: ago(12 * 24 + 2),
			summary: 'Each new email to support@ opens a thread with a reply drafted.',
			steps: [
				{at: 0, person: `Every new email to support@: work out what they need, check the logs or the database where it helps, and draft a reply in our voice. Never send. I'll read the drafts.`},
				{
					at: 0.3,
					script: `const voice = await pap.call(vault, 'entries.list', {query: 'write'});\nconst recent = await pap.call(support, 'emails.list', {folder: 'Sent', limit: 10});\nreturn {voice: voice[0].title, sent: recent.length};`,
					result: `{"voice":"How Shuttle writes","sent":10}`,
					acts: [
						{on: 'handbook', collection: 'entries', action: 'list', query: 'write', ms: 90},
						{on: 'handbook', collection: 'entries', action: 'view', title: 'How Shuttle writes', ms: 60},
						{on: 'support', collection: 'emails', action: 'list', query: 'in:Sent', ms: 1400},
					],
				},
				{
					at: 1,
					answer: `Set up: each new email to support@shuttleoutcomes.com opens its own thread here, with what I found and a reply drafted in support@'s Drafts, in the voice from the Shuttle handbook ("Short sentences. Say what happened, then what we did.").\n\nSending is off for me on that mailbox, so nothing goes out until you send it.`,
				},
			],
		},
		{
			persona: 'support',
			title: 'Support inbox: Notion keeps asking me to sign in',
			start: ago(46),
			opened: {
				alert: 'support',
				change: {
					id: '8814',
					title: 'Notion keeps asking me to sign in',
					url: null,
					summary:
						'From Jonas Berger <jonas@kiln.studio>. Hi, my Notion connection asks me to sign in again every day or two. I sign in, it works, then the agents say the connection needs signing in again. Is this a known thing?',
				},
			},
			summary: 'A token-refresh race signs Notion connections out; SHU-224 filed and a reply drafted.',
			steps: [
				{
					at: 0.2,
					script: `const org = await pap.call(observability, 'query_database', {sql: "SELECT o.id FROM \\"User\\" u JOIN \\"OrgMember\\" m ON m.\\"userId\\" = u.id JOIN \\"Organization\\" o ON o.id = m.\\"orgId\\" WHERE u.email = 'jonas@kiln.studio'"});\nreturn await pap.call(observability, 'query_logs', {query: '{service="api"} |= "notion" |= "' + org.rows[0].id + '"', since: '7d', limit: 100});`,
					result: `{"lines":100,"note":"credentials_rejected 6 times in 7 days, each 40-90 ms after another refresh of the same connection's token"}`,
					acts: [
						{on: 'support', collection: 'emails', action: 'view', title: 'Notion keeps asking me to sign in', ms: 1200},
						tool('query_database', {sql: `SELECT o.id FROM "User" u JOIN "OrgMember" m ON m."userId" = u.id JOIN "Organization" o ON o.id = m."orgId" WHERE u.email = $1`}, 500),
						tool('query_logs', {query: '{service="api"} |= "notion" |= "credentials_rejected"', since: '7d', limit: 100}, 1900),
					],
				},
				{
					at: 2.5,
					script: `const issue = await pap.call(linear, 'save_issue', {team: 'SHU', title: 'Notion: two refreshes at once sign the connection out', priority: 2});\nawait pap.call(support, 'replies.draft', {to: '8814', body: draft});\nreturn issue.identifier;`,
					result: `"SHU-224"`,
					acts: [
						{on: 'linear', collection: 'issues', action: 'list', query: 'notion refresh', ms: 700},
						{on: 'linear', collection: 'issues', action: 'create', title: 'Notion: two refreshes at once sign the connection out', ms: 1200},
						{on: 'support', collection: 'replies', action: 'draft', title: 'Re: Notion keeps asking me to sign in', ms: 1600},
					],
				},
				{
					at: 3.5,
					answer: `**It's our bug.** Notion gives a new refresh token each time we refresh and revokes the old one. When two of Jonas's agents refreshed within ~50 ms of each other, the second refresh used the revoked token and signed the connection out. 6 times this week for him.\n\n- Filed **SHU-224** (high): refresh a connection's token under a lock.\n- **Draft in support@:**\n\n> Hi Jonas,\n>\n> You found a bug of ours. When two of your agents use Notion at the same moment, we refresh the sign-in twice and Notion signs the second one out. We're fixing it this week.\n>\n> Until then, signing in again on the connection's page gets you going. Nothing was lost.\n>\n> Konsti, Shuttle`,
				},
			],
		},
		{
			persona: 'support',
			title: 'Support inbox: Two Gmail accounts?',
			start: ago(20),
			opened: {
				alert: 'support',
				change: {
					id: '8830',
					title: 'Two Gmail accounts?',
					url: null,
					summary:
						'From Priya Raman <priya@lumenlabs.io>. Can I connect both my work and my personal Gmail, and give my agents different access to each? I want Claude to read work email but not personal.',
				},
			},
			summary: 'Yes, two connections with their own permissions; reply drafted.',
			steps: [
				{
					at: 0.2,
					script: `const email = await pap.call(support, 'emails.view', {id: '8830'});\nconst docs = await pap.call(exa, 'web_fetch_exa', {urls: ['https://docs.shuttleoutcomes.com/connections/google']});\nawait pap.call(support, 'replies.draft', {to: '8830', body: draft});`,
					result: `{"drafted":true}`,
					acts: [
						{on: 'support', collection: 'emails', action: 'view', title: 'Two Gmail accounts?', ms: 1100},
						{on: 'exa', collection: 'pages', action: 'read', title: 'https://docs.shuttleoutcomes.com/connections/google', ms: 1200},
						{on: 'support', collection: 'replies', action: 'draft', title: 'Re: Two Gmail accounts?', ms: 1500},
					],
				},
				{
					at: 1.2,
					answer: `A how-to question; nothing's broken. **Draft in support@:**\n\n> Hi Priya,\n>\n> Yes. Connect each Gmail on its own; each becomes its own connection with its own permissions.\n>\n> Then open Claude on the Agents page and turn off "Read email" for the personal one. Claude keeps reading work email and can't see personal mail at all.\n>\n> Konsti, Shuttle`,
				},
			],
		},
		{
			persona: 'support',
			title: 'Support inbox: Charged twice in November',
			start: ago(5.2),
			opened: {
				alert: 'support',
				change: {
					id: '8841',
					title: 'Charged twice in November',
					url: null,
					summary: 'From Marcus Webb <marcus@fieldnotes.co>. Hey, I see two charges of $20 from Shuttle on Nov 3 on my card. Can you refund one?',
				},
			},
			waiting: true,
			unread: true,
			summary: 'Duplicate charge confirmed; the refund in Stripe is Konsti’s, then the drafted reply can go.',
			steps: [
				{
					at: 0.2,
					script: `const rows = await pap.call(observability, 'query_database', {sql: "SELECT i.\\"createdAt\\", i.amount, i.status FROM \\"Invoice\\" i JOIN \\"Organization\\" o ON o.id = i.\\"orgId\\" JOIN \\"User\\" u ON u.id = o.\\"ownerUserId\\" WHERE u.email = 'marcus@fieldnotes.co' ORDER BY 1 DESC LIMIT 5"});\nreturn rows;`,
					result: `{"rows":[{"createdAt":"2026-11-03T17:02:41Z","amount":2000,"status":"paid"},{"createdAt":"2026-11-03T17:02:00Z","amount":2000,"status":"paid"},{"createdAt":"2026-10-03T17:01:12Z","amount":2000,"status":"paid"}]}`,
					acts: [
						{on: 'support', collection: 'emails', action: 'view', title: 'Charged twice in November', ms: 1000},
						tool(
							'query_database',
							{
								sql: `SELECT i."createdAt", i.amount, i.status FROM "Invoice" i JOIN "Organization" o ON o.id = i."orgId" JOIN "User" u ON u.id = o."ownerUserId" WHERE u.email = $1 ORDER BY 1 DESC LIMIT 5`,
							},
							700,
						),
						{on: 'linear', collection: 'issues', action: 'view', title: 'SHU-201', ms: 600},
					],
				},
				{
					at: 1.5,
					script: `await pap.call(support, 'replies.draft', {to: '8841', body: draft});`,
					result: `{"drafted":true}`,
					acts: [{on: 'support', collection: 'replies', action: 'draft', title: 'Re: Charged twice in November', ms: 1400}],
				},
				{
					at: 2,
					answer: `**Marcus was charged twice.** Two $20 invoices on Nov 3, 41 seconds apart. That's the double-click bug from **SHU-201**, fixed on Nov 6, so it won't happen again.\n\n**The refund is yours:** I can't reach Stripe from here. Refund the second one (17:02:41). Then the drafted reply is ready to send:\n\n> Hi Marcus,\n>\n> You're right, we charged you twice on Nov 3. A bug of ours, fixed since. We've refunded the second $20; it shows on your card in 5–10 days.\n>\n> Sorry for the trouble.\n>\n> Konsti, Shuttle`,
				},
			],
		},
		// ---- Shopping --------------------------------------------------------------------------
		{
			persona: 'shopping',
			title: 'Cycling spend this year',
			start: ago(5 * 24 + 4),
			summary: '$1,184 on cycling this year, most of it a wheelset in June.',
			steps: [
				{at: 0, person: `How much have I spent on cycling this year?`},
				{
					at: 0.2,
					script: `const tx = await pap.call(plaid, 'transactions.list', {from: '2026-01-01', query: 'bike OR cycle OR rapha OR strava OR "mike\\'s bikes"'});\nreturn tx.map(t => [t.date, t.name, t.amount]);`,
					result: `[["2026-06-14","Mike's Bikes SF",689.0],["2026-03-02","Rapha",210.0],["2026-01-08","Strava",79.99],["2026-08-21","Sports Basement",123.4],["2026-10-30","Mike's Bikes SF",81.6]]`,
					acts: [
						{on: 'plaid', collection: 'accounts', action: 'list', ms: 800},
						{on: 'plaid', collection: 'transactions', action: 'list', query: 'bike cycle rapha strava', ms: 1700},
					],
				},
				{
					at: 0.8,
					answer: `**$1,184 this year**, on your Chase card:\n\n| | |\n|---|---|\n| Wheelset, Mike's Bikes (Jun 14) | $689.00 |\n| Rapha (Mar 2) | $210.00 |\n| Sports Basement (Aug 21) | $123.40 |\n| Service, Mike's Bikes (Oct 30) | $81.60 |\n| Strava, yearly (Jan 8) | $79.99 |`,
				},
			],
		},
		{
			persona: 'shopping',
			title: 'Gravel bike under $3,000',
			start: ago(30),
			waiting: true,
			summary: 'Three gravel bikes in stock in Konsti’s size; waiting on whether to book a test ride Saturday.',
			steps: [
				{at: 0, person: `I want a gravel bike for weekend rides in Marin, up to $3,000. Find me three good options I can buy in SF, in stock in my size.`},
				{
					at: 0.3,
					script: `const fit = await pap.call(vault, 'entries.list', {query: 'bike'});\nconst reviews = await pap.call(exa, 'web_search_exa', {query: 'best gravel bike under $3000 2026 review'});\nreturn {fit: fit[0].title, picks: reviews.results.slice(0, 6).map(r => r.title)};`,
					result: `{"fit":"Bike fit","picks":["Specialized Diverge Comp E5 review","Canyon Grizl CF SL 7 long-term test","Trek Checkpoint ALR 5: the value pick","Cannondale Topstone 2","Giant Revolt Advanced 2","Salsa Warbird C GRX 600"]}`,
					acts: [
						{on: 'vault', collection: 'entries', action: 'list', query: 'bike', ms: 80},
						{on: 'vault', collection: 'entries', action: 'view', title: 'Bike fit', ms: 50},
						{on: 'exa', collection: 'searches', action: 'run', title: 'best gravel bike under $3000 2026 review', ms: 2100},
						{on: 'exa', collection: 'searches', action: 'run', title: 'gravel bike Marin headlands tire clearance 45mm', ms: 1800},
					],
				},
				{
					at: 2,
					say: `Your fit is in the vault (186 cm, 58 or L). Checking three shops at once for stock in your size.`,
					subAgents: [
						{
							title: "Check stock at Mike's Bikes",
							brief: `Find which gravel bikes under $3,000 Mike's Bikes in San Francisco has in stock in size 58 or L, with prices. Report a short list.`,
							steps: [
								{
									at: 0.2,
									script: `return await pap.call(exa, 'web_search_exa', {query: "site:mikesbikes.com gravel bike in stock San Francisco 58"});`,
									result: `{"results":[{"title":"Specialized Diverge Comp E5 — Mike's Bikes","price":"$2,600","stock":"Valencia St: 2 in 58"}]}`,
									acts: [
										{on: 'exa', collection: 'searches', action: 'run', title: 'site:mikesbikes.com gravel bike in stock San Francisco 58', ms: 1900},
										{on: 'exa', collection: 'pages', action: 'read', title: 'https://www.mikesbikes.com/product/diverge-comp-e5', ms: 1400},
									],
								},
								{at: 2.5, answer: `Specialized Diverge Comp E5, $2,600: 2 in size 58 at the Valencia St store. Also a Diverge Sport Carbon at $3,400, over budget.`},
							],
						},
						{
							title: 'Check stock at Sports Basement',
							brief: `Find which gravel bikes under $3,000 Sports Basement (Presidio or Bryant St) has in stock in size 58 or L, with prices. Report a short list.`,
							steps: [
								{
									at: 0.3,
									script: `return await pap.call(exa, 'web_search_exa', {query: 'Sports Basement Presidio gravel bike Trek Checkpoint in stock'});`,
									result: `{"results":[{"title":"Trek Checkpoint ALR 5 — Sports Basement","price":"$2,399","stock":"Presidio: 1 in 58"}]}`,
									acts: [
										{on: 'exa', collection: 'searches', action: 'run', title: 'Sports Basement Presidio gravel bike Trek Checkpoint in stock', ms: 2000},
										{on: 'exa', collection: 'pages', action: 'read', title: 'https://shop.sportsbasement.com/products/trek-checkpoint-alr-5', ms: 1300},
									],
								},
								{at: 3, answer: `Trek Checkpoint ALR 5, $2,399: 1 in size 58 at the Presidio store. Nothing else under $3,000 in your size.`},
							],
						},
						{
							title: 'Check Canyon direct',
							brief: `Canyon sells direct only. Find the Grizl CF SL 7's price and how fast it ships to San Francisco in size L. Report price and delivery.`,
							steps: [
								{
									at: 0.2,
									script: `return await pap.call(exa, 'web_fetch_exa', {urls: ['https://www.canyon.com/en-us/gravel-bikes/all-road/grizl/cf-sl/grizl-cf-sl-7/']});`,
									result: `{"price":"$2,699","sizes":{"L":"Ships in 3-5 days"}}`,
									acts: [{on: 'exa', collection: 'pages', action: 'read', title: 'https://www.canyon.com/en-us/gravel-bikes/all-road/grizl/cf-sl/grizl-cf-sl-7/', ms: 1600}],
								},
								{at: 2, answer: `Canyon Grizl CF SL 7, $2,699: size L ships in 3–5 days, delivered boxed; you put the bars and wheels on. No test rides, but 30 days to return it.`},
							],
						},
					],
				},
				{at: 4.5, report: "Check stock at Mike's Bikes"},
				{at: 4.8, report: 'Check Canyon direct'},
				{at: 5.4, report: 'Check stock at Sports Basement'},
				{
					at: 5.6,
					script: `return await pap.call(google, 'availability.check', {from: nextSaturday(9), to: nextSaturday(13)});`,
					result: `{"free":[["10:00","13:00"]]}`,
					acts: [{on: 'google', collection: 'availability', action: 'check', ms: 700}],
				},
				{
					at: 6.5,
					answer: `Three in stock in your size, all under $3,000:\n\n| | Price | Your size | Where |\n|---|---|---|---|\n| **Specialized Diverge Comp E5** | $2,600 | 58 | Mike's Bikes, Valencia St: 2 left |\n| **Canyon Grizl CF SL 7** | $2,699 | L | Canyon direct, ships in 3–5 days |\n| **Trek Checkpoint ALR 5** | $2,399 | 58 | Sports Basement Presidio: 1 left |\n\n**My pick is the Diverge.** Carbon, room for 47 mm tires for Marin's fire roads, and you can ride it before you buy. The Grizl is the best bike for the money but can't be test-ridden; the Checkpoint is aluminum and heavier.\n\nYou're free Saturday 10:00–13:00. **Want me to put a test ride at Mike's Bikes on your calendar for 10:30?**`,
				},
			],
		},
		// ---- Travel ----------------------------------------------------------------------------
		{
			persona: 'travel',
			title: 'Flights home for Christmas',
			start: ago(3 * 24 + 2),
			summary: 'LH 455 on Dec 18, back Jan 2; calendar blocked, check-in reminder set for Dec 17.',
			steps: [
				{at: 0, person: `Find me flights home to Frankfurt for Christmas. Leave after my last meeting before the break, back before Jan 4. Nonstop if possible.`},
				{
					at: 0.2,
					script: `const events = await pap.call(google, 'events.list', {from: '2026-12-14', to: '2026-12-24'});\nconst prefs = await pap.call(vault, 'entries.list', {query: 'flight'});\nreturn {last: events.filter(e => e.attendees > 1).at(-1), prefs: prefs.map(p => p.title)};`,
					result: `{"last":{"title":"Shuttle board update","start":"2026-12-17T15:00:00-08:00","end":"2026-12-17T16:30:00-08:00"},"prefs":["Flights","Miles & More","Home in Germany"]}`,
					acts: [
						{on: 'google', collection: 'events', action: 'list', query: 'Dec 14 – Dec 24', ms: 900},
						{on: 'vault', collection: 'entries', action: 'list', query: 'flight', ms: 70},
						{on: 'vault', collection: 'entries', action: 'view', title: 'Flights', ms: 50},
						{on: 'vault', collection: 'entries', action: 'view', title: 'Miles & More', ms: 50},
					],
				},
				{
					at: 1.2,
					script: `const out = await pap.call(exa, 'web_search_exa', {query: 'SFO to FRA nonstop December 18 2026 Lufthansa United fares'});\nconst back = await pap.call(exa, 'web_search_exa', {query: 'FRA to SFO nonstop January 2 2027'});\nreturn [...out.results, ...back.results].slice(0, 6).map(r => r.title);`,
					result: `["LH 455 SFO-FRA Fri 18 Dec 15:40 from $1,284 rt","UA 58 SFO-FRA Fri 18 Dec 18:00 from $1,212 rt","LH 455 Sat 19 Dec from $1,190 rt","LH 454 FRA-SFO Sat 2 Jan 13:10","UA 59 FRA-SFO Sat 2 Jan 10:05","Condor DE 2080 SFO-FRA Thu 17 Dec"]`,
					acts: [
						{on: 'exa', collection: 'searches', action: 'run', title: 'SFO to FRA nonstop December 18 2026 Lufthansa United fares', ms: 2300},
						{on: 'exa', collection: 'searches', action: 'run', title: 'FRA to SFO nonstop January 2 2027', ms: 2100},
						{on: 'exa', collection: 'pages', action: 'read', title: 'https://www.lufthansa.com/us/en/flight-search', ms: 1800},
						{on: 'exa', collection: 'pages', action: 'read', title: 'https://www.united.com/en/us/fsr/choose-flights', ms: 1600},
					],
				},
				{
					at: 3,
					answer: `Your last meeting before the break is the **board update on Thursday Dec 17**, until 16:30. Nonstop options with an aisle seat free on each:\n\n| Out | Back | Round trip |\n|---|---|---|\n| **LH 455** Fri Dec 18, 15:40 → 11:25 next day | **LH 454** Sat Jan 2, 13:10 → 15:35 | $1,284 |\n| **UA 58** Fri Dec 18, 18:00 → 13:55 next day | **UA 59** Sat Jan 2, 10:05 → 13:00 | $1,212 |\n| **LH 455** Sat Dec 19 | **LH 454** Sun Jan 3 | $1,190 |\n\nLufthansa earns miles on your Miles & More number (ending 4417). Which one?`,
				},
				{at: 52, person: `LH 455 on the 18th, back on the 2nd.`},
				{
					at: 52.3,
					script: `await pap.call(google, 'events.create', {title: 'LH 455 SFO → FRA', start: '2026-12-18T15:40:00-08:00', end: '2026-12-19T11:25:00+01:00'});\nawait pap.call(google, 'events.create', {title: 'LH 454 FRA → SFO', start: '2027-01-02T13:10:00+01:00', end: '2027-01-02T15:35:00-08:00'});\nawait pap.call(google, 'events.create', {title: 'Out of office: Frankfurt', start: '2026-12-19', end: '2027-01-02', allDay: true});`,
					result: `{"created":3}`,
					acts: [
						{on: 'google', collection: 'events', action: 'create', title: 'LH 455 SFO → FRA', ms: 1100},
						{on: 'google', collection: 'events', action: 'create', title: 'LH 454 FRA → SFO', ms: 1000},
						{on: 'google', collection: 'events', action: 'create', title: 'Out of office: Frankfurt', ms: 900},
					],
				},
				{
					at: 53.5,
					answer: `I can't buy tickets, so here's everything ready for you:\n\n- **Book:** [LH 455 / LH 454 on lufthansa.com](https://www.lufthansa.com/us/en/flight-search?origin=SFO&destination=FRA&outbound=2026-12-18&inbound=2027-01-02&cabin=economy&adults=1), $1,284. Your Miles & More number ends in 4417; it's in the vault.\n- **Calendar:** added *LH 455 SFO → FRA* and *LH 454 FRA → SFO*, and *Out of office: Frankfurt* from Dec 19 to Jan 2.\n- **Check-in:** I'll remind you here when it opens, Thursday Dec 17 at 16:40, and pick the aisle seat with you.\n\nSafe travels home.`,
					alert: {
						title: 'Check in for LH 455',
						brief: 'Online check-in for LH 455 (SFO → FRA, Dec 18 15:40) opens now. Remind Konsti, with the check-in link, and suggest an aisle seat near the front.',
						at: pst('2026-12-17T16:40:00'),
					},
				},
			],
		},
		// ---- General ---------------------------------------------------------------------------
		{
			persona: 'general',
			title: 'Talk run-through with Arne',
			start: ago(4.4),
			summary: 'Booked a 30-minute talk run-through with Arne tomorrow at 14:00.',
			steps: [
				{at: 0, person: `Find 30 minutes with Arne in the next two days to run through the talk.`},
				{
					at: 0.2,
					script: `const window = {from: 'tomorrow 09:00', to: 'in 2 days 18:00'};\nconst [mine, arnes] = await Promise.all([\n  pap.call(google, 'availability.check', window),\n  pap.call(arneCalendar, 'availability.check', window),\n]);\nreturn firstFreeTogether(mine, arnes, 30);`,
					result: `{"slot":{"start":"tomorrow 14:00","end":"tomorrow 14:30"},"alsoFree":["tomorrow 16:30","in 2 days 10:00"]}`,
					acts: [
						{on: 'google', collection: 'availability', action: 'check', ms: 700},
						{on: 'arneCalendar', collection: 'availability', action: 'check', ms: 800},
					],
				},
				{
					at: 1,
					script: `return await pap.call(google, 'events.create', {title: 'Talk run-through', start: 'tomorrow 14:00', end: 'tomorrow 14:30', guests: ['arne@midrender.com'], conference: 'meet'});`,
					result: `{"id":"5r0q8m2c1k","htmlLink":"https://calendar.google.com/calendar/event?eid=NXIwcThtMmMxaw","guests":["arne@midrender.com"]}`,
					acts: [{on: 'google', collection: 'events', action: 'create', title: 'Talk run-through', ms: 1100}],
				},
				{
					at: 1.5,
					answer: `Booked **Talk run-through** for **tomorrow, 14:00–14:30**, with a Meet link, and invited Arne. It's the first half hour you're both free.\n\nIf that doesn't suit, you're both also free tomorrow at 16:30 and the day after at 10:00.\n\nArne's calendar only tells me when he's busy, not what his meetings are.`,
				},
			],
		},
		{
			persona: 'general',
			title: 'What I promised in yesterday’s calls',
			start: ago(19),
			summary: 'Three promises from yesterday’s calls, two due this week.',
			steps: [
				{at: 0, person: `What did I promise people in yesterday's calls?`},
				{
					at: 0.2,
					script: `const notes = await pap.call(granola, 'list_meetings', {from: yesterday});\nconst full = await pap.call(granola, 'get_meetings', {ids: notes.map(n => n.id)});\nreturn full.map(n => ({title: n.title, actions: n.actionItems.filter(a => a.owner === 'Konsti')}));`,
					result: `[{"title":"Fieldnotes onboarding","actions":["Send the SSO setup guide","Check why their Linear sync lags"]},{"title":"Design sync with Dana","actions":["Review the new persona picker by Friday"]},{"title":"Investor update prep","actions":[]}]`,
					acts: [
						{on: 'granola', collection: 'notes', action: 'list', ms: 900},
						{on: 'granola', collection: 'notes', action: 'view', title: 'Fieldnotes onboarding', ms: 1100},
						{on: 'granola', collection: 'notes', action: 'view', title: 'Design sync with Dana', ms: 1000},
						{on: 'granola', collection: 'notes', action: 'view', title: 'Investor update prep', ms: 900},
						{on: 'linear', collection: 'issues', action: 'list', query: 'Fieldnotes linear sync', ms: 800},
					],
				},
				{
					at: 1,
					answer: `Three promises, from two of yesterday's four calls:\n\n**Fieldnotes onboarding** (with Marcus)\n- Send the SSO setup guide. *You said "today".*\n- Find out why their Linear sync lags. There's no issue for it yet; want one?\n\n**Design sync with Dana**\n- Review the new persona picker **by Friday**.\n\nThe investor update prep had no action items for you.`,
				},
			],
		},
	];

	// What the outside agents did, beside the personas: a few weeks of work, two still under way.
	const tasks: AgentTask[] = [
		{
			agent: 'claudeCode',
			title: 'Rename Personal Agent Proxy to Shuttle in the docs',
			goal: 'Rename the product to Shuttle across the docs site, keeping old links working with redirects.',
			start: ago(0.6),
			minutes: 36,
			outcome: null,
			acts: [
				{on: 'linear', collection: 'issues', action: 'view', title: 'SHU-218', ms: 500},
				{on: 'github', collection: 'api', action: 'read', query: 'GET /repos/personalagentproxy/proxy/pulls/418', ms: 420},
				{on: 'notion', collection: 'pages', action: 'view', title: 'Brand: Shuttle naming', ms: 1100},
				{on: 'github', collection: 'git', action: 'read', title: REPO, ms: 900},
				{on: 'github', collection: 'git', action: 'push', title: REPO, query: 'docs-rename-shuttle', ms: 1300},
			],
		},
		{
			agent: 'devin',
			title: 'SHU-223: show the thread’s model in its header',
			goal: 'Show which model a thread runs on next to its title, and let the person switch it from there.',
			start: ago(1.3),
			minutes: 78,
			outcome: null,
			via: 'cli',
			acts: [
				{on: 'linear', collection: 'issues', action: 'view', title: 'SHU-223', ms: 600},
				{on: 'linear', collection: 'issues', action: 'update', title: 'SHU-223', ms: 700},
				{on: 'github', collection: 'git', action: 'read', title: REPO, ms: 1100},
				{on: 'github', collection: 'api', action: 'read', query: 'POST /graphql query PullRequestByNumber', ms: 430},
			],
		},
		{
			agent: 'devin',
			title: 'SHU-221: sandbox list flickers on wake',
			goal: 'Stop the sandbox list from flickering back to Asleep while a wake is in progress.',
			start: ago(4.6),
			minutes: 64,
			outcome: 'Opened #433: the list keeps a pending wake’s row as Waking until the wake answers. 9 tests.',
			via: 'cli',
			acts: [
				{on: 'linear', collection: 'issues', action: 'view', title: 'SHU-221', ms: 600},
				{on: 'github', collection: 'git', action: 'read', title: REPO, ms: 1200},
				{on: 'support', collection: 'emails', action: 'list', query: 'sandbox flicker', outcome: 'denied', ms: 40},
				{on: 'observability', collection: 'tools', action: 'query_logs', query: JSON.stringify({query: '{service="web"} |= "sandbox"', since: '3d', limit: 50}), ms: 1700},
				{on: 'github', collection: 'git', action: 'push', title: REPO, query: 'devin/shu-221-sandbox-flicker', ms: 1500},
				{on: 'github', collection: 'api', action: 'contribute', query: 'POST /graphql mutation CreatePullRequest', ms: 1300},
				{on: 'linear', collection: 'issues', action: 'update', title: 'SHU-221', ms: 700},
			],
		},
		{
			agent: 'claude',
			title: 'Outline for the Shuttle talk',
			goal: 'Draft an outline for a 20-minute talk on Shuttle: why agents need a proxy for people’s accounts, and a live tour.',
			start: ago(22),
			minutes: 14,
			outcome: 'Wrote the outline as a Notion page: the problem, permissions per agent, the activity log, building Shuttle in Shuttle, Q&A.',
			acts: [
				{on: 'notion', collection: 'pages', action: 'list', query: 'talk', ms: 900},
				{on: 'notion', collection: 'pages', action: 'view', title: 'Shuttle: positioning', ms: 1200},
				{on: 'granola', collection: 'notes', action: 'list', ms: 800},
				{on: 'granola', collection: 'notes', action: 'view', title: 'Investor update prep', ms: 1000},
				{on: 'notion', collection: 'pages', action: 'create', title: 'Talk: Building Shuttle in Shuttle', ms: 1800},
			],
		},
		{
			agent: 'chatgpt',
			title: 'November spending',
			goal: 'Sum up this month’s card spending by category.',
			start: ago(44),
			minutes: 4,
			outcome: '$3,412 so far in November: rent aside, mostly travel and eating out.',
			acts: [
				{on: 'plaid', collection: 'accounts', action: 'list', ms: 700},
				{on: 'plaid', collection: 'transactions', action: 'list', query: '2026-11-01..', ms: 1900},
				{on: 'google', collection: 'emails', action: 'list', query: 'receipt november', outcome: 'denied', ms: 40},
			],
		},
		{
			agent: 'claudeCode',
			title: 'Hotfix: IMAP search timeout',
			goal: 'Ship the IMAP search timeout fix today.',
			start: ago(8 * 24 + 6),
			minutes: 22,
			outcome: 'Pushing to main was refused; pushed the fix to a branch and opened #409 instead.',
			acts: [
				{on: 'observability', collection: 'tools', action: 'query_logs', query: JSON.stringify({query: '{service="api"} |~ "(?i)imap.*timed out"', since: '1d', limit: 40}), ms: 1800},
				{on: 'github', collection: 'git', action: 'read', title: REPO, ms: 1000},
				{on: 'github', collection: 'git', action: 'pushDefault', title: REPO, query: 'main', outcome: 'denied', ms: 60},
				{on: 'github', collection: 'git', action: 'push', title: REPO, query: 'imap-search-timeout', ms: 1400},
				{on: 'github', collection: 'api', action: 'contribute', query: 'POST /graphql mutation CreatePullRequest', ms: 1200},
			],
		},
		{
			agent: 'claude',
			title: 'Summarize this week’s customer calls',
			goal: 'Read this week’s customer calls and pull out what people asked for most.',
			start: ago(4 * 24 + 3),
			minutes: 9,
			outcome: 'Five calls; the asks: Outlook calendar (3 of 5), per-agent spending limits, and a Slack connection.',
			acts: [
				{on: 'granola', collection: 'notes', action: 'list', ms: 800},
				{on: 'granola', collection: 'notes', action: 'view', title: 'Fieldnotes onboarding', ms: 1000},
				{on: 'granola', collection: 'notes', action: 'view', title: 'Kiln Studio check-in', ms: 1000},
				{on: 'granola', collection: 'notes', action: 'view', title: 'Lumen Labs demo', ms: 1100},
				{on: 'granola', collection: 'transcripts', action: 'view', title: 'Lumen Labs demo', ms: 2100},
				{on: 'plaid', collection: 'transactions', action: 'list', query: 'lumen', outcome: 'denied', ms: 40},
				{on: 'notion', collection: 'pages', action: 'create', title: 'Customer asks: week 46', ms: 1700},
			],
		},
		// The last day, busy as a working day is: several at once, some long.
		{
			agent: 'claudeCode',
			title: 'Fix the Outlook watch resync',
			goal: 'After a quiet week the Outlook watch starts over with a full sync; make that cheap and show it on the connection page.',
			start: ago(9.2),
			minutes: 48,
			outcome: 'Pushed to #431: a full resync reads only the window the watch needs, and the connection page says when it happened.',
			acts: [
				{on: 'github', collection: 'api', action: 'read', query: 'POST /graphql query PullRequestReviewThreads', ms: 520},
				{on: 'linear', collection: 'issues', action: 'view', title: 'SHU-225', ms: 600},
				{on: 'exa', collection: 'pages', action: 'read', title: 'https://learn.microsoft.com/en-us/graph/delta-query-events', ms: 1300},
				{on: 'github', collection: 'git', action: 'read', title: REPO, ms: 900},
				{on: 'observability', collection: 'tools', action: 'query_logs', query: JSON.stringify({query: '{service="api"} |= "outlook" |= "delta"', since: '2d', limit: 50}), ms: 1600},
				{on: 'github', collection: 'git', action: 'push', title: REPO, query: 'outlook-calendar', ms: 1400},
				{on: 'github', collection: 'api', action: 'contribute', query: 'POST /graphql mutation AddPullRequestReviewThreadReply', ms: 1100},
				{on: 'github', collection: 'api', action: 'contribute', query: 'POST /graphql mutation ResolveReviewThread', ms: 900},
				{on: 'linear', collection: 'issues', action: 'update', title: 'SHU-225', ms: 700},
			],
		},
		{
			agent: 'claudeCode',
			title: 'Profile the thread list query',
			goal: 'Find why listing threads got slow for large workspaces.',
			start: ago(13.5),
			minutes: 34,
			outcome: 'The newest-entry lookup scans AgentEntry; an index on (threadId, seq desc) fixes it. Handed to On-call’s PR #430.',
			acts: [
				{
					on: 'observability',
					collection: 'tools',
					action: 'query_metrics',
					query: JSON.stringify({query: 'histogram_quantile(0.95, sum by (le) (rate(mcp_tool_seconds_bucket{tool="chat.threads.list"}[1h])))', since: '7d', step: '1h'}),
					ms: 1200,
				},
				{on: 'observability', collection: 'tools', action: 'list_tables', query: JSON.stringify({table: 'AgentEntry'}), ms: 300},
				{
					on: 'observability',
					collection: 'tools',
					action: 'query_database',
					query: JSON.stringify({sql: 'EXPLAIN SELECT "id" FROM "AgentEntry" WHERE "threadId" = $1 ORDER BY "seq" DESC LIMIT 1'}),
					ms: 800,
				},
				{on: 'observability', collection: 'tools', action: 'query_database', query: JSON.stringify({sql: 'SELECT "orgId", count(*) FROM "AgentThread" GROUP BY 1 ORDER BY 2 DESC LIMIT 5'}), ms: 1900},
				{on: 'github', collection: 'api', action: 'read', query: 'GET /repos/personalagentproxy/proxy/pulls/430', ms: 400},
			],
		},
		{
			agent: 'devin',
			title: 'SHU-219: retry Granola token refresh',
			goal: 'Retry a Granola token refresh that fails with a 5xx instead of signing the connection out.',
			start: ago(11.4),
			minutes: 72,
			outcome: 'Opened #432: a refresh that fails with a 5xx is retried twice with backoff; only a 4xx signs the connection out.',
			via: 'cli',
			acts: [
				{on: 'linear', collection: 'issues', action: 'view', title: 'SHU-219', ms: 600},
				{on: 'github', collection: 'git', action: 'read', title: REPO, ms: 1200},
				{on: 'observability', collection: 'tools', action: 'query_logs', query: JSON.stringify({query: '{service="api"} |= "granola" |= "refresh"', since: '7d', limit: 100}), ms: 2100},
				{on: 'observability', collection: 'tools', action: 'query_metrics', query: JSON.stringify({query: 'sum by (status) (increase(granola_refresh_total[1d]))', since: '7d', step: '1d'}), ms: 900},
				{on: 'github', collection: 'git', action: 'push', title: REPO, query: 'devin/shu-219-granola-refresh-retry', ms: 1500},
				{on: 'github', collection: 'git', action: 'pushDefault', title: REPO, query: 'main', outcome: 'denied', ms: 50},
				{on: 'github', collection: 'api', action: 'contribute', query: 'POST /graphql mutation CreatePullRequest', ms: 1300},
				{on: 'linear', collection: 'issues', action: 'update', title: 'SHU-219', ms: 700},
			],
		},
		{
			agent: 'devin',
			title: 'Triage new bugs',
			goal: 'Label and size the bugs filed since yesterday.',
			start: ago(16.2),
			minutes: 14,
			outcome: 'Labeled five, closed one as a duplicate of SHU-224.',
			via: 'cli',
			acts: [
				{on: 'linear', collection: 'issues', action: 'list', query: 'label:bug created:>-1d', ms: 900},
				{on: 'linear', collection: 'issues', action: 'view', title: 'SHU-226', ms: 500},
				{on: 'linear', collection: 'issues', action: 'update', title: 'SHU-226', ms: 600},
				{on: 'linear', collection: 'issues', action: 'update', title: 'SHU-227', ms: 600},
				{on: 'linear', collection: 'issues', action: 'update', title: 'SHU-228', ms: 600},
			],
		},
		{
			agent: 'devin',
			title: 'Usage numbers for the investor update',
			goal: 'For Arne: weekly active workspaces, agents connected and requests made, for each of the last 12 weeks, as a table in Notion.',
			start: ago(18.4),
			minutes: 23,
			outcome: 'Wrote “Usage, last 12 weeks” in Notion: weekly active workspaces up from 61 to 212, requests per week from 41k to 389k.',
			via: 'cli',
			acts: [
				{on: 'observability', collection: 'tools', action: 'list_tables', query: JSON.stringify({}), ms: 400},
				{
					on: 'observability',
					collection: 'tools',
					action: 'query_database',
					query: JSON.stringify({sql: `SELECT date_trunc('week', "createdAt") w, count(DISTINCT "orgId") FROM "AuditEntry" WHERE "createdAt" > now() - interval '12 weeks' GROUP BY 1 ORDER BY 1`}),
					ms: 6200,
				},
				{
					on: 'observability',
					collection: 'tools',
					action: 'query_database',
					query: JSON.stringify({sql: `SELECT date_trunc('week', "createdAt") w, count(*) FROM "Agent" GROUP BY 1 ORDER BY 1`}),
					ms: 900,
				},
				{on: 'observability', collection: 'tools', action: 'query_metrics', query: JSON.stringify({query: 'sum(increase(http_requests_total{route="/mcp"}[1w]))', since: '12w', step: '1w'}), ms: 1300},
				{on: 'notion', collection: 'pages', action: 'list', query: 'investor update', ms: 800},
				{on: 'notion', collection: 'pages', action: 'create', title: 'Usage, last 12 weeks', ms: 1700},
			],
		},
		{
			agent: 'devin',
			title: 'SHU-230: annual billing on the pricing page',
			goal: 'For Arne: add a monthly/annual switch to the website’s pricing page, annual at two months free.',
			start: ago(6.1),
			minutes: 51,
			outcome: 'Opened #434: a monthly/annual switch on the pricing page, annual shown as $16/month billed yearly.',
			via: 'cli',
			acts: [
				{on: 'linear', collection: 'issues', action: 'view', title: 'SHU-230', ms: 600},
				{on: 'notion', collection: 'pages', action: 'view', title: 'Pricing 2027', ms: 1100},
				{on: 'github', collection: 'git', action: 'read', title: REPO, ms: 1100},
				{on: 'github', collection: 'git', action: 'push', title: REPO, query: 'devin/shu-230-annual-billing', ms: 1500},
				{on: 'github', collection: 'api', action: 'contribute', query: 'POST /graphql mutation CreatePullRequest', ms: 1300},
				{on: 'github', collection: 'api', action: 'contribute', query: 'POST /graphql mutation RequestReviews', ms: 800},
				{on: 'linear', collection: 'issues', action: 'update', title: 'SHU-230', ms: 700},
			],
		},
		{
			agent: 'claude',
			title: 'Prepare for the Fieldnotes call',
			goal: 'What did we last talk about with Fieldnotes, and what is still open for them?',
			start: ago(7.3),
			minutes: 9,
			outcome: 'Summed up: SSO guide still owed, their Linear sync lags, and the double charge on Nov 3 is being refunded.',
			acts: [
				{on: 'granola', collection: 'notes', action: 'list', ms: 800},
				{on: 'granola', collection: 'notes', action: 'view', title: 'Fieldnotes onboarding', ms: 1000},
				{on: 'google', collection: 'emails', action: 'list', query: 'from:fieldnotes.co', ms: 1100},
				{on: 'support', collection: 'emails', action: 'list', query: 'fieldnotes', ms: 1300},
				{on: 'linear', collection: 'issues', action: 'list', query: 'Fieldnotes', ms: 700},
			],
		},
		{
			agent: 'claude',
			title: 'Changelog entry for Outlook calendar',
			goal: 'Write the changelog entry announcing the Outlook calendar connection.',
			start: ago(2.6),
			minutes: 7,
			outcome: 'Drafted the entry in Notion, under this week’s changelog.',
			acts: [
				{on: 'github', collection: 'api', action: 'read', query: 'GET /repos/personalagentproxy/proxy/pulls/431', ms: 450},
				{on: 'notion', collection: 'pages', action: 'view', title: 'Changelog', ms: 1000},
				{on: 'notion', collection: 'pages', action: 'update', title: 'Changelog', outcome: 'denied', ms: 40},
				{on: 'notion', collection: 'pages', action: 'create', title: 'Changelog: Outlook calendar', ms: 1600},
			],
		},
		{
			agent: 'chatgpt',
			title: 'Diverge or Grizl?',
			goal: 'Which gravel bike is the better buy for fire roads: the Specialized Diverge Comp E5 or the Canyon Grizl CF SL 7?',
			start: ago(20.5),
			minutes: 6,
			outcome: 'The Grizl for the money, the Diverge for the test ride and the local shop.',
			acts: [
				{on: 'exa', collection: 'searches', action: 'run', title: 'Specialized Diverge Comp E5 vs Canyon Grizl CF SL 7', ms: 2000},
				{on: 'exa', collection: 'pages', action: 'read', title: 'https://www.bikeradar.com/reviews/bikes/gravel-bikes', ms: 1500},
				{on: 'exa', collection: 'searches', action: 'run', title: 'Grizl CF SL 7 tire clearance', ms: 1700},
			],
		},
		{
			agent: 'chatgpt',
			title: 'Flights this year',
			goal: 'How much did I spend on flights this year?',
			start: ago(10.1),
			minutes: 3,
			outcome: '$4,870 on flights this year, across six trips.',
			acts: [
				{on: 'plaid', collection: 'transactions', action: 'list', query: 'lufthansa united alaska', ms: 1800},
				{on: 'vault', collection: 'entries', action: 'list', query: 'flight', ms: 80},
			],
		},
	];

	// Smaller work that fills the weeks around it, picked at random times (seed-showcase.ts).
	const routine: Array<Omit<AgentTask, 'start'>> = [
		{
			agent: 'claudeCode',
			title: 'Look up an error in production',
			goal: 'Find what a 500 in the web app was.',
			minutes: 6,
			outcome: 'A Notion page too large to preview; filed it.',
			acts: [
				{on: 'observability', collection: 'tools', action: 'query_logs', query: JSON.stringify({query: '{service="api", level="error"}', since: '1h', limit: 20}), ms: 1500},
				{on: 'linear', collection: 'issues', action: 'create', title: 'Large Notion pages fail to preview', ms: 1100},
			],
		},
		{
			agent: 'claudeCode',
			title: 'Check the open issues',
			goal: 'List what is open and assigned to Konsti.',
			minutes: 3,
			outcome: 'Nine open, three due this week.',
			acts: [{on: 'linear', collection: 'issues', action: 'list', query: 'assignee:me state:open', ms: 900}],
		},
		{
			agent: 'claudeCode',
			title: 'Open a PR for the branch',
			goal: 'Push the branch and open its pull request.',
			minutes: 4,
			outcome: 'Opened the pull request.',
			acts: [
				{on: 'github', collection: 'git', action: 'push', title: REPO, query: 'fix-sidebar-unread', ms: 1300},
				{on: 'github', collection: 'api', action: 'contribute', query: 'POST /graphql mutation CreatePullRequest', ms: 1200},
			],
		},
		{
			agent: 'claudeCode',
			title: 'Count sign-ups this week',
			goal: 'How many people signed up this week?',
			minutes: 2,
			outcome: '204 sign-ups this week.',
			acts: [{on: 'observability', collection: 'tools', action: 'query_database', query: JSON.stringify({sql: `SELECT count(*) FROM "User" WHERE "createdAt" > now() - interval '7 days'`}), ms: 600}],
		},
		{
			agent: 'devin',
			title: 'Fix a flaky test',
			goal: 'Make the alerts sweep test stop failing now and then.',
			minutes: 31,
			outcome: 'Opened a PR: the test waited on wall-clock time.',
			via: 'cli',
			acts: [
				{on: 'github', collection: 'git', action: 'read', title: REPO, ms: 1000},
				{on: 'github', collection: 'git', action: 'push', title: REPO, query: 'devin/flaky-alert-sweep', ms: 1400},
				{on: 'github', collection: 'api', action: 'contribute', query: 'POST /graphql mutation CreatePullRequest', ms: 1200},
			],
		},
		{
			agent: 'devin',
			title: 'Triage new bugs',
			goal: 'Label and size the bugs filed since yesterday.',
			minutes: 8,
			outcome: 'Labeled four, closed one as a duplicate.',
			via: 'cli',
			acts: [
				{on: 'linear', collection: 'issues', action: 'list', query: 'label:bug created:>-1d', ms: 900},
				{on: 'linear', collection: 'issues', action: 'update', title: 'SHU-215', ms: 600},
				{on: 'linear', collection: 'issues', action: 'update', title: 'SHU-216', ms: 600},
			],
		},
		{
			agent: 'claude',
			title: 'Prepare for a customer call',
			goal: 'What did we last talk about with this customer?',
			minutes: 5,
			outcome: 'Summed up the last call and the open asks.',
			acts: [
				{on: 'granola', collection: 'notes', action: 'list', ms: 800},
				{on: 'granola', collection: 'notes', action: 'view', title: 'Kiln Studio check-in', ms: 1000},
				{on: 'google', collection: 'emails', action: 'list', query: 'from:kiln.studio', ms: 1100},
			],
		},
		{
			agent: 'claude',
			title: 'Draft the changelog',
			goal: 'Write this week’s changelog from what was merged.',
			minutes: 7,
			outcome: 'Drafted the changelog in Notion.',
			acts: [
				{on: 'github', collection: 'api', action: 'read', query: 'POST /graphql query MergedPullRequests', ms: 600},
				{on: 'notion', collection: 'pages', action: 'create', title: 'Changelog', ms: 1500},
			],
		},
		{
			agent: 'chatgpt',
			title: 'Compare two flights',
			goal: 'Which of two flights is better value?',
			minutes: 3,
			outcome: 'The nonstop, by four hours for $70.',
			acts: [{on: 'exa', collection: 'searches', action: 'run', title: 'LH 455 vs UA 58 seat pitch economy', ms: 1900}],
		},
		{agent: 'chatgpt', title: 'Check the balance', goal: 'How much is in checking?', minutes: 1, outcome: 'Read the balance.', acts: [{on: 'plaid', collection: 'accounts', action: 'list', ms: 800}]},
	];

	return {alerts, threads, tasks, routine};
}
