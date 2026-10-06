import {beforeEach, describe, expect, mock, test} from 'bun:test';

const mockEnv: {ENCRYPTION_KEY: string | undefined} = {ENCRYPTION_KEY: undefined};

mock.module('./env', () => ({env: mockEnv}));

const KEY = Buffer.alloc(32, 7).toString('base64');
const OTHER_KEY = Buffer.alloc(32, 8).toString('base64');

beforeEach(() => {
	mockEnv.ENCRYPTION_KEY = KEY;
});

describe('credential crypto', () => {
	test('decrypts what it encrypted', async () => {
		const {encryptCredential, decryptCredential} = await import('./credential-crypto');
		const stored = encryptCredential('{"password":"abcd efgh ijkl mnop"}').unwrap();

		expect(stored.startsWith('v1.')).toBe(true);
		expect(stored).not.toContain('abcd');
		expect(decryptCredential(stored).unwrap()).toBe('{"password":"abcd efgh ijkl mnop"}');
	});

	test('encrypts the same value differently each time', async () => {
		const {encryptCredential} = await import('./credential-crypto');
		expect(encryptCredential('secret').unwrap()).not.toBe(encryptCredential('secret').unwrap());
	});

	test('fails under another key', async () => {
		const {encryptCredential, decryptCredential} = await import('./credential-crypto');
		const stored = encryptCredential('secret').unwrap();
		mockEnv.ENCRYPTION_KEY = OTHER_KEY;

		expect(decryptCredential(stored).unwrapErr().kind).toBe('internal_error');
	});

	test('fails when the ciphertext was changed', async () => {
		const {encryptCredential, decryptCredential} = await import('./credential-crypto');
		const [version, iv, tag] = encryptCredential('secret').unwrap().split('.');
		const forged = [version, iv, tag, Buffer.from('public').toString('base64url')].join('.');

		expect(decryptCredential(forged).unwrapErr().kind).toBe('internal_error');
	});

	test('fails without a key', async () => {
		mockEnv.ENCRYPTION_KEY = undefined;
		const {encryptCredential} = await import('./credential-crypto');

		expect(encryptCredential('secret').unwrapErr().kind).toBe('internal_error');
	});
});
