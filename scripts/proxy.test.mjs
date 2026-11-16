import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const cli = fileURLToPath(new URL('./proxy.mjs', import.meta.url));
async function run(args) {
	const child = spawn(process.execPath, [cli, ...args], {stdio: ['ignore', 'pipe', 'pipe']});
	let stdout = '',
		stderr = '';
	child.stdout.on('data', (chunk) => {
		stdout += chunk;
	});
	child.stderr.on('data', (chunk) => {
		stderr += chunk;
	});
	return new Promise((resolve) => child.on('close', (code) => resolve({code, stdout, stderr})));
}
async function fixture(t, handler) {
	const directory = await mkdtemp(join(tmpdir(), 'proxy-cli-test-'));
	const cookie = join(directory, 'session');
	await writeFile(cookie, 'proxy-agent-session=example', {mode: 0o600});
	const server = createServer(handler);
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	t.after(async () => {
		server.closeAllConnections();
		await new Promise((resolve) => server.close(resolve));
		await rm(directory, {recursive: true});
	});
	return [
		'run',
		'--url',
		'http://127.0.0.1:' + server.address().port,
		'--project',
		'example',
		'--session-file',
		cookie,
	];
}
test('injects without printing values, preserves child args and exit status', async (t) => {
	const args = await fixture(t, (req, res) => {
		assert.equal(req.url, '/api/agent/environments/development/example');
		assert.equal(req.headers.cookie, 'proxy-agent-session=example');
		res.end(JSON.stringify({variables: {EXAMPLE_SECRET: 'invented-secret', EMPTY: ''}}));
	});
	const result = await run([
		...args,
		'--',
		process.execPath,
		'-e',
		'if(process.env.EXAMPLE_SECRET !== "invented-secret" || process.env.EMPTY !== "") process.exit(1); process.exit(23)',
		'--',
		'--env',
		'child-option',
	]);
	assert.equal(result.code, 23);
	assert.equal(result.stdout, '');
	assert.equal(result.stderr, '');
});
test('denial never starts the child or prints response body', async (t) => {
	const args = await fixture(t, (_req, res) => {
		res.writeHead(403);
		res.end('sensitive-body');
	});
	const result = await run([...args, '--', process.execPath, '-e', 'console.log("CHILD_STARTED")']);
	assert.equal(result.code, 1);
	assert.equal(result.stdout, '');
	assert.match(result.stderr, /403/);
	assert.doesNotMatch(result.stderr, /sensitive-body/);
});
test('refuses redirect instead of forwarding the cookie', async (t) => {
	const args = await fixture(t, (_req, res) => {
		res.writeHead(302, {Location: 'https://example.com/'});
		res.end();
	});
	const result = await run([...args, '--', process.execPath, '-e', 'console.log("CHILD_STARTED")']);
	assert.equal(result.code, 1);
	assert.equal(result.stdout, '');
});
test('invalid payload never starts command', async (t) => {
	const args = await fixture(t, (_req, res) =>
		res.end(JSON.stringify({variables: {'INVALID-NAME': 'value'}})),
	);
	const result = await run([...args, '--', process.execPath, '-e', 'console.log("CHILD_STARTED")']);
	assert.equal(result.code, 1);
	assert.match(result.stderr, /Invalid environment response/);
});
test('requires option values and refuses remote cleartext', async () => {
	assert.equal((await run(['run', '--url', '--project', 'example', '--', 'echo'])).code, 1);
	const result = await run([
		'run',
		'--url',
		'http://example.com',
		'--project',
		'example',
		'--',
		'echo',
	]);
	assert.equal(result.code, 1);
	assert.match(result.stderr, /HTTPS/);
});
