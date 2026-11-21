import {describe, expect, test} from 'bun:test';

import {confirmUrl, readConfirmToken, signConfirmToken} from './confirm-link';

const SECRET = 'auth-secret';
const now = new Date('2026-11-16T12:00:00Z');
const claims = {appId: 'app-1', teamId: 'T01', slackUserId: 'U01', channel: 'D01', ts: '1700000000.000100', expiresAt: now.getTime() / 1000 + 24 * 60 * 60};

describe('the link to confirm who a Slack user is', () => {
	test('is read back as it was made, within its day', () => {
		const token = signConfirmToken(claims, SECRET);

		expect(readConfirmToken(token, SECRET, now).unwrap()).toEqual(claims);
		expect(confirmUrl('https://proxy.example.com', token)).toBe(`https://proxy.example.com/confirm-slack/${token}`);
		expect(token).toMatch(/^[\w-]+\.[\w-]+$/);
	});

	test('runs out after its day', () => {
		const token = signConfirmToken(claims, SECRET);

		expect(readConfirmToken(token, SECRET, new Date(claims.expiresAt * 1000)).unwrapErr()).toBe('expired');
	});

	test('is not one where it was altered, signed with another secret, or made up', () => {
		const token = signConfirmToken(claims, SECRET);
		const [, signature] = token.split('.');
		const altered = Buffer.from(JSON.stringify({app: 'app-1', team: 'T01', user: 'U99', channel: 'D01', ts: '1700000000.000100', exp: claims.expiresAt})).toString('base64url');

		expect(readConfirmToken(`${altered}.${signature}`, SECRET, now).unwrapErr()).toBe('invalid');
		expect(readConfirmToken(signConfirmToken(claims, 'another'), SECRET, now).unwrapErr()).toBe('invalid');
		expect(readConfirmToken('not-a-link', SECRET, now).unwrapErr()).toBe('invalid');
		expect(readConfirmToken(`${token}x`, SECRET, now).unwrapErr()).toBe('invalid');
	});

	test('runs out even where its signature is right, once its time is past', () => {
		const token = signConfirmToken({...claims, expiresAt: now.getTime() / 1000 - 1}, SECRET);

		expect(readConfirmToken(token, SECRET, now).unwrapErr()).toBe('expired');
	});
});
