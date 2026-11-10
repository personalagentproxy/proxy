import {afterAll, beforeAll, beforeEach, describe, expect, test} from 'bun:test';
import {createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse} from 'node:http';
import {type AddressInfo, connect} from 'node:net';
import {gzipSync} from 'node:zlib';

import {GITHUB_TOKEN, githubConnection, logAgentRequest, papToken, resetFixture, startApp, useConnections} from './relay-fixture';

// The routes, through the whole app, against a fake GitHub on a local port: what reaches GitHub,
// what comes back, and what is logged.

const {GITHUB_ORIGINS} = await import('./origins');
const {pktLine} = await import('./pkt-line');

type Received = {method: string; url: string; headers: IncomingHttpHeaders; body: Buffer};

// What the fake GitHub was sent, and how it answers the next request.
const received: Received[] = [];
let answer: (req: IncomingMessage, res: ServerResponse, body: Buffer) => void = (_req, res) => res.end('ok');
// Called with each chunk of a request body as it arrives, for a test to see it stream.
let onChunk: (chunk: Buffer) => void = () => {};

function fakeGitHub(req: IncomingMessage, res: ServerResponse): void {
	const chunks: Buffer[] = [];
	req.on('data', (chunk: Buffer) => {
		chunks.push(chunk);
		onChunk(chunk);
	});
	req.on('end', () => {
		const body = Buffer.concat(chunks);
		received.push({method: req.method ?? '', url: req.url ?? '', headers: req.headers, body});
		answer(req, res, body);
	});
}

let app: Server;
let github: Server;
let base = '';

beforeAll(async () => {
	const started = await startApp();
	app = started.server;
	base = started.base;
	github = createServer(fakeGitHub).listen(0);
	await new Promise((resolve) => github.once('listening', resolve));
	const fake = `http://localhost:${(github.address() as AddressInfo).port}`;
	GITHUB_ORIGINS.git = fake;
	GITHUB_ORIGINS.api = fake;
});

afterAll(() => {
	app.close();
	github.close();
});

beforeEach(() => {
	resetFixture();
	received.length = 0;
	answer = (_req, res) => res.end('ok');
	onChunk = () => {};
});

const BASIC = `Basic ${Buffer.from(`x-access-token:${GITHUB_TOKEN}`).toString('base64')}`;

function request(path: string, init: RequestInit & {decompress?: boolean} = {}): Promise<Response> {
	const headers = new Headers(init.headers);
	if (!headers.has('authorization')) {
		headers.set('authorization', `Bearer ${papToken()}`);
	}
	return fetch(`${base}/api/cli/github${path}`, {redirect: 'manual', decompress: false, ...init, headers});
}

// A request's status, its path sent exactly as given, over a socket: an HTTP client would resolve the dots itself.
function rawStatus(path: string): Promise<number> {
	const {port} = new URL(base);
	return new Promise((resolve, reject) => {
		const socket = connect(Number(port), 'localhost', () => {
			socket.write(`GET ${path} HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer ${papToken()}\r\nConnection: close\r\n\r\n`);
		});
		let head = '';
		socket.on('data', (chunk: Buffer) => {
			head += chunk.toString('latin1');
		});
		socket.on('end', () => resolve(Number(head.split(' ')[1])));
		socket.on('error', reject);
	});
}

function logged(): Array<Record<string, string | null>> {
	return logAgentRequest.mock.calls.map(([entry]) => ({
		collectionId: entry.collectionId,
		action: entry.action,
		recordTitle: entry.recordTitle,
		query: entry.query,
		outcome: entry.outcome,
		...(entry.error ? {error: entry.error} : {}),
	}));
}

describe('GET identity', () => {
	test('the account, its name, and GitHub’s noreply address, never the person’s own', async () => {
		const res = await request('/identity');

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({connection: 'github-1', login: 'octo-dana', name: 'Dana Octo', email: '1234+octo-dana@users.noreply.github.com'});
		expect(logAgentRequest).not.toHaveBeenCalled();
	});

	test('an account without a name goes by its login', async () => {
		useConnections([githubConnection('github-2', 'octo-sam')]);

		expect(await (await request('/identity')).json()).toMatchObject({login: 'octo-sam', name: 'octo-sam'});
	});

	test('without Read, refused and logged', async () => {
		useConnections([githubConnection('github-1', 'octo-dana', [])]);
		const res = await request('/identity');

		expect(res.status).toBe(403);
		expect(((await res.json()) as {message: string}).message).toStartWith('Not allowed: Read repositories (read)');
		expect(logged()).toEqual([{collectionId: 'api', action: 'read', recordTitle: null, query: 'GET identity', outcome: 'denied'}]);
	});

	test('without a good token, a 401 saying what to do', async () => {
		const res = await request('/identity', {headers: {authorization: 'Bearer nope'}});

		expect(res.status).toBe(401);
		expect(((await res.json()) as {message: string}).message).toContain('not a valid token');
	});
});

describe('which connection', () => {
	test('several, and none named, is refused with their ids and how to name one', async () => {
		useConnections([githubConnection('github-1', 'octo-dana'), githubConnection('github-2', 'acme-bot')]);
		const res = await request('/api/user');
		const body = (await res.json()) as {message: string};

		expect(res.status).toBe(400);
		expect(body.message).toBe(
			'You have several GitHub connections: github-1 (octo-dana), github-2 (acme-bot). Name one with pap --connection <id> git … or pap --connection <id> gh …, which send it as the x-pap-connection header.',
		);
		expect(received).toEqual([]);
	});

	test('one named is the one used, and the header isn’t sent on', async () => {
		useConnections([githubConnection('github-1', 'octo-dana'), githubConnection('github-2', 'acme-bot')]);
		const res = await request('/identity', {headers: {'x-pap-connection': 'github-2'}});
		await request('/api/user', {headers: {'x-pap-connection': 'github-2'}});

		expect(await res.json()).toMatchObject({connection: 'github-2', login: 'acme-bot'});
		expect(received[0]?.headers['x-pap-connection']).toBeUndefined();
		expect(logAgentRequest).toHaveBeenCalledWith(expect.objectContaining({connectionId: 'github-2'}));
	});

	test('one the agent doesn’t reach is not found, in the CLI’s words; one not GitHub’s is refused', async () => {
		const missing = await request('/api/user', {headers: {'x-pap-connection': 'someone-elses'}});
		useConnections([{...githubConnection('mail-1', 'dana@example.com', ['read'], 'email')}]);
		const mail = await request('/api/user', {headers: {'x-pap-connection': 'mail-1'}});

		expect(missing.status).toBe(404);
		expect(await missing.json()).toEqual({message: 'No connection someone-elses; see `pap connections`.'});
		expect(mail.status).toBe(400);
		expect(((await mail.json()) as {message: string}).message).toStartWith('mail-1 is Email, not GitHub');
		expect(received).toEqual([]);
	});

	test('none at all is refused, saying the person has to connect GitHub', async () => {
		useConnections([]);
		const res = await request('/api/user');

		expect(res.status).toBe(404);
		expect(((await res.json()) as {message: string}).message).toContain('connect GitHub');
	});
});

describe('git', () => {
	test('info/refs goes to GitHub with the connection’s token as git’s password, and isn’t logged', async () => {
		answer = (_req, res) => {
			res.writeHead(200, {'content-type': 'application/x-git-upload-pack-advertisement', 'www-authenticate': 'Basic realm="GitHub"', 'set-cookie': 'x=y'});
			res.end('001e# service=git-upload-pack\n0000');
		};
		const res = await request('/git/acme/demo.git/info/refs?service=git-upload-pack', {
			headers: {'git-protocol': 'version=2', 'user-agent': 'git/2.50', cookie: 'session=abc', 'x-forwarded-for': '10.0.0.1'},
		});

		expect(res.status).toBe(200);
		expect(await res.text()).toBe('001e# service=git-upload-pack\n0000');
		expect(res.headers.get('www-authenticate')).toBeNull();
		expect(res.headers.get('set-cookie')).toBeNull();
		expect(received).toHaveLength(1);
		expect(received[0]).toMatchObject({method: 'GET', url: '/acme/demo.git/info/refs?service=git-upload-pack'});
		const sent = received[0]?.headers ?? {};
		expect(sent.authorization).toBe(BASIC);
		expect(sent['git-protocol']).toBe('version=2');
		expect(sent['user-agent']).toBe('git/2.50');
		expect(sent.cookie).toBeUndefined();
		expect(sent['x-forwarded-for']).toBeUndefined();
		expect(JSON.stringify(sent)).not.toContain(papToken().split('.')[0]);
		expect(logAgentRequest).not.toHaveBeenCalled();
	});

	test('an upload-pack POST listing refs isn’t logged; one fetching is, gzipped and passed through untouched', async () => {
		const lsRefs = Buffer.concat([pktLine('command=ls-refs\n'), Buffer.from('0001'), pktLine('peel\n'), Buffer.from('0000')]);
		const fetchBody = gzipSync(Buffer.concat([pktLine('command=fetch\n'), Buffer.from('0001'), pktLine(`want ${'b'.repeat(40)}\n`), pktLine('done\n'), Buffer.from('0000')]));
		const type = {'content-type': 'application/x-git-upload-pack-request'};

		await request('/git/acme/demo.git/git-upload-pack', {method: 'POST', headers: type, body: lsRefs});
		await request('/git/acme/demo/git-upload-pack', {method: 'POST', headers: {...type, 'content-encoding': 'gzip'}, body: fetchBody});

		expect(received.map((one) => one.url)).toEqual(['/acme/demo.git/git-upload-pack', '/acme/demo.git/git-upload-pack']);
		expect(received[1]?.body.equals(fetchBody)).toBe(true);
		expect(received[1]?.headers['content-encoding']).toBe('gzip');
		expect(logged()).toEqual([{collectionId: 'git', action: 'read', recordTitle: 'acme/demo', query: null, outcome: 'allowed'}]);
	});

	test('a push is logged with the refs it updates', async () => {
		useConnections([githubConnection('github-1', 'octo-dana', ['read', 'push'])]);
		const body = Buffer.concat([
			pktLine(`${'a'.repeat(40)} ${'b'.repeat(40)} refs/heads/fix-login\0report-status side-band-64k`),
			pktLine(`${'0'.repeat(40)} ${'c'.repeat(40)} refs/tags/v1.2`),
			Buffer.from('0000PACK'),
		]);

		const res = await request('/git/acme/demo.git/git-receive-pack', {method: 'POST', headers: {'content-type': 'application/x-git-receive-pack-request'}, body});

		expect(res.status).toBe(200);
		expect(received[0]?.body.equals(body)).toBe(true);
		expect(logged()).toEqual([{collectionId: 'git', action: 'push', recordTitle: 'acme/demo', query: 'fix-login, refs/tags/v1.2', outcome: 'allowed'}]);
	});

	test('without Push, info/refs for a push is refused as git shows it, logged, and GitHub sent nothing', async () => {
		const res = await request('/git/acme/demo.git/info/refs?service=git-receive-pack');
		const text = await res.text();

		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toBe('application/x-git-receive-pack-advertisement');
		expect(text).toMatch(/^[0-9a-f]{4}ERR Not allowed: Push commits \(push\), which git push needs, on GitHub connection github-1\. The person who made this login can allow it\.$/);
		expect(received).toEqual([]);
		expect(logged()).toEqual([{collectionId: 'git', action: 'push', recordTitle: 'acme/demo', query: null, outcome: 'denied'}]);
	});

	test('a push POST refused is answered on the side band, which git shows', async () => {
		const res = await request('/git/acme/demo.git/git-receive-pack', {method: 'POST', body: '0000'});

		expect(res.headers.get('content-type')).toBe('application/x-git-receive-pack-result');
		expect(await res.text()).toMatch(/^[0-9a-f]{4}\x03Not allowed: Push commits/);
		expect(logged()).toEqual([{collectionId: 'git', action: 'push', recordTitle: 'acme/demo', query: null, outcome: 'denied'}]);
	});

	test('Git LFS, and anything else of git’s, is refused in plain words, unlogged', async () => {
		const lfs = await request('/git/acme/demo.git/info/lfs/objects/batch', {method: 'POST', body: '{}', headers: {'content-type': 'application/vnd.git-lfs+json'}});
		const dumb = await request('/git/acme/demo.git/HEAD');

		expect(lfs.status).toBe(400);
		expect(await lfs.text()).toContain('Git LFS isn’t supported through pap git yet');
		expect(dumb.status).toBe(400);
		expect(received).toEqual([]);
		expect(logAgentRequest).not.toHaveBeenCalled();
	});

	test('GitHub turning the token down is the sign-in rejected, in words git shows, and logged as failed', async () => {
		answer = (_req, res) => {
			res.writeHead(401, {'www-authenticate': 'Basic realm="GitHub"'});
			res.end('Invalid username or token.');
		};
		const res = await request('/git/acme/demo.git/info/refs?service=git-upload-pack');
		const text = await res.text();

		expect(res.status).toBe(200);
		expect(text).toContain('ERR Sign-in rejected: the person must reconnect this account.');
		expect(res.headers.get('www-authenticate')).toBeNull();
		expect(logged()).toEqual([{collectionId: 'git', action: 'read', recordTitle: 'acme/demo', query: null, outcome: 'failed', error: 'credentials_rejected 401'}]);
	});

	test('GitHub’s 404 is GitHub’s answer, passed back and logged as allowed', async () => {
		answer = (_req, res) => {
			res.writeHead(404, {'content-type': 'text/plain'});
			res.end('Repository not found.');
		};
		const res = await request('/git/acme/demo.git/git-upload-pack', {method: 'POST', body: Buffer.concat([pktLine('command=fetch\n'), Buffer.from('0000')])});

		expect(res.status).toBe(404);
		expect(await res.text()).toBe('Repository not found.');
		expect(logged()).toEqual([{collectionId: 'git', action: 'read', recordTitle: 'acme/demo', query: null, outcome: 'allowed'}]);
	});
});

describe('the API', () => {
	test('a GET goes to GitHub with the token as the bearer, and is logged by its method and path, without its query', async () => {
		answer = (_req, res) => {
			res.writeHead(200, {'content-type': 'application/json', 'x-ratelimit-remaining': '4999', 'www-authenticate': 'Bearer'});
			res.end('{"full_name":"acme/demo"}');
		};
		const res = await request('/api/repos/acme/demo?per_page=1', {headers: {accept: 'application/vnd.github+json'}});
		const text = await res.text();

		expect(res.status).toBe(200);
		expect(text).toBe('{"full_name":"acme/demo"}');
		expect(res.headers.get('x-ratelimit-remaining')).toBe('4999');
		expect(res.headers.get('www-authenticate')).toBeNull();
		expect(received[0]).toMatchObject({method: 'GET', url: '/repos/acme/demo?per_page=1'});
		expect(received[0]?.headers.authorization).toBe(`Bearer ${GITHUB_TOKEN}`);
		expect(received[0]?.headers.accept).toBe('application/vnd.github+json');
		expect(logged()).toEqual([{collectionId: 'api', action: 'read', recordTitle: 'acme/demo', query: 'GET /repos/acme/demo', outcome: 'allowed'}]);
	});

	test('a write without Write is refused as GitHub refuses, logged, and GitHub sent nothing', async () => {
		const res = await request('/api/repos/acme/demo/pulls', {method: 'POST', headers: {'content-type': 'application/json'}, body: '{"title":"Fix"}'});

		expect(res.status).toBe(403);
		expect(await res.json()).toEqual({
			message: 'Not allowed: Change things on GitHub (write), which POST /repos/acme/demo/pulls needs, on GitHub connection github-1. The person who made this login can allow it.',
		});
		expect(received).toEqual([]);
		expect(logged()).toEqual([{collectionId: 'api', action: 'write', recordTitle: 'acme/demo', query: 'POST /repos/acme/demo/pulls', outcome: 'denied'}]);
	});

	test('a write with Write goes with its JSON body as it was sent, not read by the server’s JSON parser', async () => {
		useConnections([githubConnection('github-1', 'octo-dana', ['read', 'write'])]);
		answer = (_req, res) => {
			res.writeHead(201, {'content-type': 'application/json'});
			res.end('{"number":7}');
		};
		const body = '{"title":"Fix the login",  "head":"fix-login"}';
		const res = await request('/api/repos/acme/demo/pulls', {method: 'POST', headers: {'content-type': 'application/json'}, body});

		expect(res.status).toBe(201);
		expect(received[0]?.body.toString()).toBe(body);
		expect(received[0]?.headers['content-type']).toBe('application/json');
		expect(logged()).toEqual([{collectionId: 'api', action: 'write', recordTitle: 'acme/demo', query: 'POST /repos/acme/demo/pulls', outcome: 'allowed'}]);
	});

	test('a GraphQL query reads; a mutation writes; each logged with its operation', async () => {
		const query = JSON.stringify({query: 'query Viewer { viewer { login } }'});
		const mutation = JSON.stringify({query: 'mutation AddComment($input: AddCommentInput!) { addComment(input: $input) { clientMutationId } }', variables: {input: {}}});

		const read = await request('/api/graphql', {method: 'POST', headers: {'content-type': 'application/json'}, body: query});
		const write = await request('/api/graphql', {method: 'POST', headers: {'content-type': 'application/json'}, body: mutation});

		expect(read.status).toBe(200);
		expect(received).toHaveLength(1);
		expect(received[0]?.body.toString()).toBe(query);
		expect(write.status).toBe(403);
		expect(logged()).toEqual([
			{collectionId: 'api', action: 'read', recordTitle: null, query: 'POST /graphql query Viewer', outcome: 'allowed'},
			{collectionId: 'api', action: 'write', recordTitle: null, query: 'POST /graphql mutation AddComment', outcome: 'denied'},
		]);
	});

	test('a redirect is passed back as it is, never followed', async () => {
		answer = (_req, res) => {
			res.writeHead(301, {location: 'https://api.github.com/repositories/42'});
			res.end();
		};
		const res = await request('/api/repos/acme/old-name');

		expect(res.status).toBe(301);
		expect(res.headers.get('location')).toBe('https://api.github.com/repositories/42');
		expect(received).toHaveLength(1);
	});

	test('a gzipped answer comes back gzipped, with its Content-Encoding', async () => {
		const zipped = gzipSync(Buffer.from('{"login":"octo-dana"}'));
		answer = (_req, res) => {
			res.writeHead(200, {'content-type': 'application/json', 'content-encoding': 'gzip'});
			res.end(zipped);
		};
		const res = await request('/api/user', {headers: {'accept-encoding': 'gzip'}});

		expect(res.headers.get('content-encoding')).toBe('gzip');
		expect(Buffer.from(await res.arrayBuffer()).equals(zipped)).toBe(true);
		expect(received[0]?.headers['accept-encoding']).toBe('gzip');
	});

	test('a large body streams through as it is sent, never held whole', async () => {
		useConnections([githubConnection('github-1', 'octo-dana', ['read', 'write'])]);
		const chunk = new Uint8Array(1024 * 1024).fill(7);
		const total = 24;
		let arrived = 0;
		let firstArrived: () => void = () => {};
		const first = new Promise<void>((resolve) => {
			firstArrived = resolve;
		});
		onChunk = (bytes) => {
			arrived += bytes.length;
			firstArrived();
		};
		let sent = 0;
		// The rest is only sent once GitHub has the start, which it can't if the relay holds the body.
		const body = new ReadableStream<Uint8Array>({
			async pull(controller) {
				if (sent === 1) {
					await first;
				}
				if (sent === total) {
					controller.close();
					return;
				}
				sent++;
				controller.enqueue(chunk);
			},
		});

		const res = await request('/api/repos/acme/demo/releases/1/assets', {method: 'PUT', headers: {'content-type': 'application/octet-stream'}, body});

		expect(res.status).toBe(200);
		expect(arrived).toBe(total * chunk.length);
		expect(received[0]?.body.length).toBe(total * chunk.length);
	});

	test('GitHub’s 401 is the sign-in rejected, said so, and logged as failed; out of reach, failed too', async () => {
		answer = (_req, res) => {
			res.writeHead(401, {'content-type': 'application/json'});
			res.end('{"message":"Bad credentials"}');
		};
		const rejected = await request('/api/user');
		const fake = GITHUB_ORIGINS.api;
		GITHUB_ORIGINS.api = 'http://localhost:1';
		const unreachable = await request('/api/user');
		GITHUB_ORIGINS.api = fake;

		expect(rejected.status).toBe(502);
		expect(await rejected.json()).toEqual({message: 'Sign-in rejected: the person must reconnect this account. Retrying won’t help.'});
		expect(unreachable.status).toBe(502);
		expect(await unreachable.json()).toEqual({message: 'GitHub could not be reached; try again.'});
		expect(logged()).toEqual([
			{collectionId: 'api', action: 'read', recordTitle: null, query: 'GET /user', outcome: 'failed', error: 'credentials_rejected 401'},
			{collectionId: 'api', action: 'read', recordTitle: null, query: 'GET /user', outcome: 'failed', error: 'provider_unreachable'},
		]);
	});

	test('a path that could go elsewhere is refused before anything else', async () => {
		const statuses = await Promise.all(['/api/repos/%2e%2e/user', '/api/repos/../../user', '/api//evil.example.com/x', '/api/repos/acme%2Fdemo'].map((path) => rawStatus(`/api/cli/github${path}`)));

		expect(statuses).toEqual([400, 400, 400, 400]);
		expect(received).toEqual([]);
	});

	test('the GitHub token is never in an answer or the log', async () => {
		answer = (req, res) => {
			res.writeHead(200, {'content-type': 'text/plain'});
			res.end(`seen ${req.headers['user-agent'] ?? ''}`);
		};
		const res = await request('/api/user');
		const all = [await res.text(), JSON.stringify([...res.headers]), JSON.stringify(logAgentRequest.mock.calls)].join('\n');

		expect(all).not.toContain(GITHUB_TOKEN);
	});
});
