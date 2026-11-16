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

test('interactive login hides password, saves a private session and logout revokes it', async (t) => {
	const args = await fixture(t, (req, res) => {
		if (req.url === '/agent-auth/login') {
			let body = '';
			req.on('data', (chunk) => {
				body += chunk;
			});
			req.on('end', () => {
				assert.deepEqual(JSON.parse(body), {
					username: 'example-agent',
					password: 'invented-password',
				});
				res.setHeader('Set-Cookie', 'proxy.agent-session=example-session; Path=/; HttpOnly');
				res.end('{"agentId":"example"}');
			});
			return;
		}
		assert.equal(req.url, '/agent-auth/logout');
		assert.equal(req.headers.cookie, 'proxy.agent-session=example-session');
		res.end('{"ok":true}');
	});
	const url = args[2];
	const script = [
		'import os, pty, select, sys, time',
		'pid, fd = pty.fork()',
		'if pid == 0: os.execv(sys.argv[1], [sys.argv[1], sys.argv[2], "login", "--url", sys.argv[3]])',
		'out = b""',
		'try:',
		' for prompt, answer in [(b"Agent username:", b"example-agent\\r"), (b"Agent password:", b"invented-password\\r"), (b"Signed in.", None)]:',
		'  deadline = time.time() + 15',
		'  while prompt not in out and time.time() < deadline:',
		'   if select.select([fd], [], [], 1)[0]:',
		'    try: out += os.read(fd, 4096)',
		'    except OSError: break',
		'  assert prompt in out, "Terminal prompt missing"',
		'  if answer: os.write(fd, answer)',
		' assert b"invented-password" not in out, "Password echoed"',
		' _, status = os.waitpid(pid, 0)',
		' assert status == 0, "Login failed"',
		'finally:',
		' os.close(fd)',
	].join('\n');
	const child = spawn('python3', ['-c', script, process.execPath, cli, url], {
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	let error = '';
	child.stderr.on('data', (chunk) => {
		error += chunk;
	});
	const code = await new Promise((resolve) => child.on('close', resolve));
	assert.equal(code, 0, error);
	const {homedir} = await import('node:os');
	const {stat} = await import('node:fs/promises');
	const file = join(
		homedir(),
		'.config',
		'personal-agent-proxy',
		Buffer.from(url).toString('base64url') + '.cookie',
	);
	t.after(() => rm(file, {force: true}));
	assert.equal((await stat(file)).mode & 0o777, 0o600);
	const logout = await run(['logout', '--url', url]);
	assert.equal(logout.code, 0, logout.stderr);
	await assert.rejects(stat(file), {code: 'ENOENT'});
});
