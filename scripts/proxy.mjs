#!/usr/bin/env node
import {readFile, mkdir, writeFile, chmod, rm} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join, dirname} from 'node:path';
import {spawn} from 'node:child_process';

async function main() {
	const args = process.argv.slice(2);
	const separator = args.indexOf('--');
	const flags = separator < 0 ? args : args.slice(0, separator);
	const option = (name) => {
		const index = flags.indexOf(name);
		const value = flags[index + 1];
		if (index < 0 || !value || value.startsWith('--')) {
			throw new Error('Missing value for ' + name);
		}
		return value;
	};
	if (args[0] === 'logout') {
		const server = new URL(option('--url'));
		validateServer(server);
		const file = sessionPath(server);
		const cookie = (await readFile(file, 'utf8')).trim();
		const response = await fetch(new URL('/agent-auth/logout', server), {
			method: 'POST',
			headers: {Origin: server.origin, Cookie: cookie},
			redirect: 'error',
			signal: AbortSignal.timeout(15000),
		});
		if (!response.ok) {
			throw new Error('Logout failed (HTTP ' + response.status + ')');
		}
		await rm(file, {force: true});
		console.log('Signed out.');
		return;
	}
	if (args[0] === 'login') {
		if (!flags.includes('--url')) {
			throw new Error('Usage: proxy login --url https://proxy.example.com');
		}
		const server = new URL(option('--url'));
		validateServer(server);
		if (!process.stdin.isTTY) {
			throw new Error('Login requires an interactive terminal');
		}
		process.stdout.write('Agent username: ');
		const username = await readInput(false);
		process.stdout.write('Agent password: ');
		const password = await readInput(true);
		const response = await fetch(new URL('/agent-auth/login', server), {
			method: 'POST',
			headers: {'Content-Type': 'application/json', Origin: server.origin},
			body: JSON.stringify({username, password}),
			redirect: 'error',
			signal: AbortSignal.timeout(15000),
		});
		if (!response.ok) {
			throw new Error('Login failed (HTTP ' + response.status + ')');
		}
		const cookies = response.headers
			.getSetCookie()
			.map((value) => value.split(';')[0])
			.join('; ');
		if (!cookies) {
			throw new Error('Login returned no session');
		}
		const file = sessionPath(server);
		await mkdir(dirname(file), {recursive: true, mode: 0o700});
		await writeFile(file, cookies, {mode: 0o600});
		await chmod(file, 0o600);
		console.log('Signed in. Session saved locally.');
		return;
	}
	if (
		args[0] !== 'run' ||
		!flags.includes('--project') ||
		!flags.includes('--url') ||
		separator < 0 ||
		!args[separator + 1]
	) {
		throw new Error(
			'Usage: node scripts/proxy.mjs run --url https://proxy.example.com --project example --env development --session-file /path/to/session-cookie -- command [args]',
		);
	}
	if (flags.includes('--env') && option('--env') !== 'development') {
		throw new Error('Only development is supported');
	}
	const url = new URL(option('--url'));
	validateServer(url);
	const project = option('--project');
	if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(project)) {
		throw new Error('Invalid project');
	}
	const cookie = (
		await readFile(
			flags.includes('--session-file') ? option('--session-file') : sessionPath(url),
			'utf8',
		)
	).trim();
	const response = await fetch(new URL('/api/agent/environments/development/' + project, url), {
		headers: {cookie},
		redirect: 'error',
		signal: AbortSignal.timeout(15000),
	});
	if (!response.ok) {
		throw new Error('Environment access failed (HTTP ' + response.status + ')');
	}
	const payload = await response.json();
	if (
		!payload ||
		typeof payload !== 'object' ||
		!payload.variables ||
		typeof payload.variables !== 'object' ||
		Array.isArray(payload.variables)
	) {
		throw new Error('Invalid environment response');
	}
	for (const [name, value] of Object.entries(payload.variables)) {
		if (
			!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ||
			typeof value !== 'string' ||
			value.includes('\0')
		) {
			throw new Error('Invalid environment response');
		}
	}
	const child = spawn(args[separator + 1], args.slice(separator + 2), {
		env: {...process.env, ...payload.variables},
		stdio: 'inherit',
	});
	for (const signal of ['SIGINT', 'SIGTERM']) {
		process.on(signal, () => child.kill(signal));
	}
	child.on('error', () => {
		console.error('Could not start command');
		process.exitCode = 1;
	});
	child.on('exit', (code, signal) => {
		process.exitCode = code ?? (signal === 'SIGINT' ? 130 : 143);
	});
}
main().catch((error) => {
	console.error(error.message);
	process.exitCode = 1;
});

function sessionPath(url) {
	return join(
		homedir(),
		'.config',
		'personal-agent-proxy',
		Buffer.from(url.origin).toString('base64url') + '.cookie',
	);
}
function validateServer(url) {
	if (
		url.pathname !== '/' ||
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		(url.protocol !== 'https:' &&
			!(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))
	) {
		throw new Error('Use an HTTPS server URL (HTTP is allowed only on localhost)');
	}
}
function readInput(hidden) {
	return new Promise((resolve, reject) => {
		let password = '';
		process.stdin.setRawMode(true);
		process.stdin.resume();
		process.stdin.setEncoding('utf8');
		function finish() {
			process.stdin.setRawMode(false);
			process.stdin.pause();
			process.stdin.off('data', onData);
			process.stdout.write('\n');
		}
		function onData(text) {
			for (const char of text) {
				if (char === '\u0003') {
					finish();
					reject(new Error('Login cancelled'));
					return;
				}
				if (char === '\r' || char === '\n') {
					finish();
					resolve(password);
					return;
				}
				if (char === '\u007f') {
					password = password.slice(0, -1);
					if (!hidden) {
						process.stdout.write('\b \b');
					}
					continue;
				}
				if (char >= ' ') {
					password += char;
					if (!hidden) {
						process.stdout.write(char);
					}
				}
			}
		}
		process.stdin.on('data', onData);
	});
}
