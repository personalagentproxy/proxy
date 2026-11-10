import {describe, expect, test} from 'bun:test';

import {type CliClaims, signCliToken, verifyCliToken} from './token';

const SECRET = 'test-auth-secret';
const NOW = new Date('2026-11-10T12:00:00Z');
const claims: CliClaims = {
	agentId: 'agent-1',
	orgId: 'org-1',
	taskId: 'task-1',
	sandboxId: 'sandbox-1',
	connectionId: 'sandboxes-1',
	expiresAt: NOW.getTime() / 1000 + 60,
};

// The token with one character of `part` changed, its payload or its signature.
function tamper(token: string, part: 'payload' | 'signature'): string {
	const dot = token.lastIndexOf('.');
	const at = part === 'payload' ? 'pap_'.length + 2 : dot + 2;
	const swapped = token[at] === 'A' ? 'B' : 'A';
	return `${token.slice(0, at)}${swapped}${token.slice(at + 1)}`;
}

describe('cli tokens', () => {
	test('a token signed comes back with its claims, under a prefix of its own', () => {
		const token = signCliToken(claims, SECRET);

		expect(token).toStartWith('pap_');
		expect(verifyCliToken(token, SECRET, NOW).unwrap()).toEqual(claims);
	});

	test('one past its expiry is expired, up to the second', () => {
		const token = signCliToken(claims, SECRET);

		expect(verifyCliToken(token, SECRET, new Date(claims.expiresAt * 1000 - 1)).isOk()).toBe(true);
		expect(verifyCliToken(token, SECRET, new Date(claims.expiresAt * 1000)).unwrapErr()).toBe('expired');
	});

	test('a payload changed, such as to another task, is not valid', () => {
		const token = signCliToken(claims, SECRET);
		const [signed, signature] = token.split('.');
		const otherTask = signCliToken({...claims, taskId: 'task-2'}, SECRET).split('.')[0];

		expect(verifyCliToken(tamper(token, 'payload'), SECRET, NOW).unwrapErr()).toBe('invalid');
		expect(verifyCliToken(`${otherTask}.${signature}`, SECRET, NOW).unwrapErr()).toBe('invalid');
		expect(signed).not.toBe(otherTask);
	});

	test('a signature changed is not valid', () => {
		const token = signCliToken(claims, SECRET);

		expect(verifyCliToken(tamper(token, 'signature'), SECRET, NOW).unwrapErr()).toBe('invalid');
		expect(verifyCliToken(`${token.split('.')[0]}.`, SECRET, NOW).unwrapErr()).toBe('invalid');
	});

	test('one signed with another secret is not valid', () => {
		expect(verifyCliToken(signCliToken(claims, 'another-secret'), SECRET, NOW).unwrapErr()).toBe('invalid');
	});

	test('anything else is not valid', () => {
		for (const garbage of ['', 'pap_', 'pap_.', 'pap_abc', 'Bearer pap_x.y', 'not-a-token', 'pap_e30.e30']) {
			expect(verifyCliToken(garbage, SECRET, NOW).unwrapErr()).toBe('invalid');
		}
	});
});
