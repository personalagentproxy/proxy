// `bun run crawl`, with `bun run dev` up: seeds the demo workspace, signs in to the app as a
// person, as a new organization and as an agent, visits every route the web app has, taking a
// screenshot of each and noting the links between them, and writes it all to `generated/`.
import {mkdir, readdir, readFile, rm, writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {chromium, type BrowserContext} from 'playwright-core';
import {matchRoutes} from 'react-router';
import type {Edge, EdgeKind, Screen, ScreenMap} from '../src/map-schema';
import {routePaths, WEB_ROUTER_FILE} from '../src/router-paths';

const APP_URL = process.env.APP_URL ?? 'http://localhost:5173';
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const OUT_DIR = new URL('../generated/', import.meta.url);
const VIEWPORT = {width: 1280, height: 800};

// Who a screen is seen as: signed out, the demo person, a person whose new organization has not
// been through the welcome flow yet, or one of the demo person's agents.
const CONTEXTS = ['anon', 'human', 'fresh', 'agent'] as const;
type ContextName = (typeof CONTEXTS)[number];

function contextOf(path: string): ContextName {
	if (path === '/login' || path === '/agent/login') {
		return 'anon';
	}

	if (path.startsWith('/welcome')) {
		return 'fresh';
	}

	if (path === '/agent' || path.startsWith('/agent/')) {
		return 'agent';
	}

	return 'human';
}

function fail(message: string): never {
	console.error(`[crawl] ${message}`);
	process.exit(1);
}

async function requireApp(): Promise<void> {
	const up = await fetch(`${APP_URL}/auth/methods`).then(
		(response) => response.ok,
		() => false,
	);
	if (!up) {
		fail(`Nothing answers at ${APP_URL}. Start \`bun run dev\` first.`);
	}
}

// The seed replaces the demo workspace and prints a sign-in link for it and its agents' password.
async function seed(): Promise<{signInPath: string; agentPassword: string}> {
	console.log('[crawl] Seeding the demo workspace');
	const proc = Bun.spawn(['bun', 'run', 'seed'], {
		cwd: REPO_ROOT,
		stdout: 'pipe',
		stderr: 'inherit',
	});
	const output = await new Response(proc.stdout).text();
	if ((await proc.exited) !== 0) {
		fail('The seed failed.');
	}

	const link = output.match(/(https?:\/\/\S+\/auth\/email\/verify\?\S+)/)?.[1];
	const agentPassword = output.match(/username and "([^"]+)"/)?.[1];
	if (!link || !agentPassword) {
		fail('The seed printed no sign-in link or agent password.');
	}

	// The link names the api; through the app's origin the session cookie lands where it is read.
	const url = new URL(link);
	return {signInPath: `${url.pathname}${url.search}`, agentPassword};
}

const browser = await chromium.launch({channel: 'chrome'});

function newContext(): Promise<BrowserContext> {
	return browser.newContext({
		baseURL: APP_URL,
		viewport: VIEWPORT,
		deviceScaleFactor: 2,
		colorScheme: 'light',
	});
}

async function getJson<T>(context: BrowserContext, path: string): Promise<T> {
	const response = await context.request.get(path);
	if (!response.ok()) {
		fail(`GET ${path} answered ${response.status()}.`);
	}
	return (await response.json()) as T;
}

async function postJson(context: BrowserContext, path: string, data?: object): Promise<unknown> {
	// Browser-called writes need the app's Origin, as a browser would send it.
	const response = await context.request.post(path, {data, headers: {Origin: APP_URL}});
	if (!response.ok()) {
		fail(`POST ${path} answered ${response.status()}.`);
	}
	return response.json();
}

async function signInHuman(signInPath: string): Promise<BrowserContext> {
	const context = await newContext();
	const page = await context.newPage();
	await page.goto(signInPath);
	await page.close();
	await getJson(context, '/api/me');
	return context;
}

// A throwaway person whose organization still has the welcome flow ahead of it.
async function signInFresh(): Promise<{context: BrowserContext; connectionId: string}> {
	const context = await newContext();
	await postJson(context, '/auth/dev/login', {fresh: true});
	const {connections} = await getJson<{connections: Array<{id: string}>}>(
		context,
		'/api/connections',
	);
	const connectionId = connections[0]?.id;
	if (!connectionId) {
		fail('The new organization has no connection to show the welcome flow with.');
	}
	return {context, connectionId};
}

// The first agent login that can read the vault, whose entries live in the database and so
// show without a live account, as a mailbox's or an MCP server's would need; else the first
// login that is not revoked.
async function signInAgent(human: BrowserContext, password: string): Promise<BrowserContext> {
	const {agents} = await getJson<{agents: Array<{username: string; revokedAt: string | null}>}>(
		human,
		'/api/agents',
	);
	let fallback: BrowserContext | null = null;
	for (const agent of agents) {
		if (agent.revokedAt !== null) {
			continue;
		}
		const context = await newContext();
		await postJson(context, '/agent-auth/login', {username: agent.username, password});
		const me = await getJson<{connections: Array<{integrationId: string}>}>(
			context,
			'/api/agent/me',
		);
		if (me.connections.some((connection) => connection.integrationId === 'vault')) {
			return context;
		}
		fallback ??= context;
	}
	if (!fallback) {
		fail('The seed made no agent login that is not revoked.');
	}
	return fallback;
}

// A task's pages, `/agent/:taskId/…`, make every request for the task in their address: the crawl
// starts one through the api, and opens the agent side on its pages.
async function startTask(context: BrowserContext): Promise<string> {
	const task = (await postJson(context, '/api/agent/tasks', {
		title: 'Look around',
		goal: 'See every page of the agent side for the screen map.',
	})) as {task: string};
	return task.task;
}

// `/connect-agent` only opens with a request an MCP client's sign-in sealed, so the crawl
// registers as one and starts a sign-in, taking the address the api sends the browser to.
async function connectAgentPath(human: BrowserContext): Promise<string> {
	const registered = (await postJson(human, '/oauth/register', {
		redirect_uris: ['http://127.0.0.1:9/callback'],
		client_name: 'Claude',
	})) as {client_id: string};
	const query = new URLSearchParams({
		response_type: 'code',
		client_id: registered.client_id,
		redirect_uri: 'http://127.0.0.1:9/callback',
		code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
		code_challenge_method: 'S256',
		state: 'map',
	});
	const response = await human.request.get(`/oauth/authorize?${query}`, {maxRedirects: 0});
	const location = response.headers()['location'];
	if (!location) {
		fail(`Starting an MCP sign-in answered ${response.status()} without a redirect.`);
	}
	const url = new URL(location, APP_URL);
	return `${url.pathname}${url.search}`;
}

// ---- The crawl -------------------------------------------------------------------------------

await requireApp();
const patterns = routePaths(await readFile(WEB_ROUTER_FILE, 'utf8'));
const routeObjects = patterns.map((path) => ({path}));

// Which route a link leads to, the most specific one, as the router itself picks it.
function matchLink(href: string): {pattern: string; url: string} | null {
	const url = URL.parse(href, APP_URL);
	if (!url || url.origin !== new URL(APP_URL).origin) {
		return null;
	}
	const pathname = url.pathname === '/' ? '/connections' : url.pathname;
	const pattern = matchRoutes(routeObjects, pathname)?.[0]?.route.path;
	if (!pattern) {
		return null;
	}
	return {pattern, url: `${pathname}${url.search}`};
}

const {signInPath, agentPassword} = await seed();
const human = await signInHuman(signInPath);
const fresh = await signInFresh();
const contexts: Record<ContextName, BrowserContext> = {
	anon: await newContext(),
	human,
	fresh: fresh.context,
	agent: await signInAgent(human, agentPassword),
};
const taskId = await startTask(contexts.agent);

// The folder is emptied, not replaced: Vite serves it and stops noticing files in a new one.
await mkdir(OUT_DIR, {recursive: true});
for (const file of await readdir(OUT_DIR)) {
	await rm(new URL(file, OUT_DIR));
}

// One address per route, the one its screenshot is taken at: the first link found to it, or the
// route itself where it has no parameters. Every other link to it is kept, in case the page at
// the first leads nowhere: a list with nothing in it has no record to open.
const urls = new Map<string, string>();
const candidates = new Map<string, string[]>();
const queue: string[] = [];
function discover(pattern: string, url: string): void {
	const seen = candidates.get(pattern) ?? [];
	if (!seen.includes(url)) {
		candidates.set(pattern, [...seen, url]);
	}
	if (urls.has(pattern)) {
		return;
	}
	urls.set(pattern, url);
	queue.push(pattern);
}

discover('/welcome/connections/:id', `/welcome/connections/${fresh.connectionId}`);
discover('/connect-agent', await connectAgentPath(human));
discover('/agent/:taskId', `/agent/${taskId}`);
// No page links to an invitation: the one a token nobody was sent opens.
discover('/invite/:token', '/invite/not-a-token');
for (const pattern of patterns) {
	if (!pattern.includes(':')) {
		discover(pattern, pattern);
	}
}

const screenshots = new Map<string, string>();
const edges = new Map<string, {from: string; to: string; kind: EdgeKind; labels: Set<string>}>();

function fileName(pattern: string): string {
	return `${pattern.slice(1).replace(/[/:]+/g, '-')}.png`;
}

type Anchor = {href: string; text: string; nav: boolean};

// Opens the page, takes its screenshot when it is the route's own address, and follows its links.
async function visit(pattern: string, url: string, capture: boolean): Promise<void> {
	console.log(`[crawl] ${pattern}  ${url}`);
	const page = await contexts[contextOf(pattern)].newPage();
	await page.goto(url, {waitUntil: 'networkidle'});
	await page.evaluate(() => document.fonts.ready);

	if (capture) {
		const file = fileName(pattern);
		await page.screenshot({path: fileURLToPath(new URL(file, OUT_DIR))});
		screenshots.set(pattern, file);
	}

	const anchors: Anchor[] = await page.evaluate(() =>
		[...document.querySelectorAll<HTMLAnchorElement>('a[href]')].map((anchor) => ({
			href: anchor.getAttribute('href') ?? '',
			text: anchor.innerText.trim() || anchor.getAttribute('aria-label') || '',
			// The sidebar, breadcrumbs, and the agent side's brand and feedback link, which lead home
			// and to the feedback form from every page.
			nav:
				anchor.closest('[data-slot="sidebar"], nav, footer') !== null ||
				(anchor.closest('header') !== null && anchor.getAttribute('href') === '/agent'),
		})),
	);
	await page.close();

	for (const anchor of anchors) {
		const link = matchLink(anchor.href);
		if (!link || link.pattern === pattern) {
			continue;
		}
		const kind: EdgeKind = anchor.nav ? 'nav' : 'link';
		const key = `${pattern} ${link.pattern} ${kind}`;
		const edge = edges.get(key) ?? {from: pattern, to: link.pattern, kind, labels: new Set()};
		if (anchor.text) {
			edge.labels.add(anchor.text);
		}
		edges.set(key, edge);
		if (contextOf(link.pattern) === contextOf(pattern)) {
			discover(link.pattern, link.url);
		}
	}
}

// A route still undiscovered under one that was, such as a record under its list: the other
// addresses of the list are tried, one by one, until one leads on or none are left.
function unexploredCandidate(): {pattern: string; url: string} | null {
	for (const pattern of patterns) {
		const below = patterns.filter((other) => other.startsWith(`${pattern}/`) && !urls.has(other));
		if (below.length === 0) {
			continue;
		}
		const next = (candidates.get(pattern) ?? []).find((url) => !explored.has(url));
		if (next) {
			return {pattern, url: next};
		}
	}
	return null;
}

const explored = new Set<string>();
while (queue.length > 0) {
	const pattern = queue.shift() ?? '';
	const url = urls.get(pattern) ?? pattern;
	explored.add(url);
	await visit(pattern, url, true);

	if (queue.length > 0) {
		continue;
	}
	const candidate = unexploredCandidate();
	if (candidate) {
		explored.add(candidate.url);
		await visit(candidate.pattern, candidate.url, false);
	}
}
await browser.close();

const screens: Screen[] = patterns.map((path) => {
	const url = urls.get(path);
	return {
		path,
		url: url ? `${APP_URL}${url}` : null,
		screenshot: screenshots.get(path) ?? null,
	};
});
const mapEdges: Edge[] = [...edges.values()]
	.map(({labels, ...edge}) => ({
		...edge,
		label: labels.size === 1 ? ([...labels][0] ?? null) : null,
	}))
	.sort((a, b) => `${a.from} ${a.to} ${a.kind}`.localeCompare(`${b.from} ${b.to} ${b.kind}`));
const map: ScreenMap = {
	generatedAt: new Date().toISOString(),
	viewport: VIEWPORT,
	screens,
	edges: mapEdges,
};
await writeFile(new URL('map.json', OUT_DIR), `${JSON.stringify(map, null, '\t')}\n`);

for (const screen of screens) {
	if (!screen.screenshot) {
		console.warn(`[crawl] No way found to ${screen.path}; it has no screenshot.`);
	}
}
console.log(
	`[crawl] ${screenshots.size} of ${patterns.length} screens and ${mapEdges.length} edges in ${fileURLToPath(OUT_DIR)}`,
);
