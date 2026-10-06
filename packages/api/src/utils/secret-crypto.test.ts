import {beforeEach, describe, expect, mock, test} from 'bun:test';

const mockEnv: {ENCRYPTION_KEY: string | undefined} = {ENCRYPTION_KEY: undefined};

mock.module('./env', () => ({env: mockEnv}));

const KEY = Buffer.alloc(32, 7).toString('base64');
const OTHER_KEY = Buffer.alloc(32, 8).toString('base64');

beforeEach(() => {
	mockEnv.ENCRYPTION_KEY = KEY;
});

describe('secret crypto', () => {
	test('decrypts what it encrypted', async () => {
		const {encryptSecret, decryptSecret} = await import('./secret-crypto');
		const stored = encryptSecret('{"password":"abcd efgh ijkl mnop"}').unwrap();

		expect(stored.startsWith('v1.')).toBe(true);
		expect(stored).not.toContain('abcd');
		expect(decryptSecret(stored).unwrap()).toBe('{"password":"abcd efgh ijkl mnop"}');
	});

	test('encrypts the same value differently each time', async () => {
		const {encryptSecret} = await import('./secret-crypto');
		expect(encryptSecret('secret').unwrap()).not.toBe(encryptSecret('secret').unwrap());
	});

	test('fails under another key', async () => {
		const {encryptSecret, decryptSecret} = await import('./secret-crypto');
		const stored = encryptSecret('secret').unwrap();
		mockEnv.ENCRYPTION_KEY = OTHER_KEY;

		expect(decryptSecret(stored).unwrapErr().kind).toBe('internal_error');
	});

	test('fails when the ciphertext was changed', async () => {
		const {encryptSecret, decryptSecret} = await import('./secret-crypto');
		const [version, iv, tag] = encryptSecret('secret').unwrap().split('.');
		const forged = [version, iv, tag, Buffer.from('public').toString('base64url')].join('.');

		expect(decryptSecret(forged).unwrapErr().kind).toBe('internal_error');
	});

	test('fails without a key', async () => {
		mockEnv.ENCRYPTION_KEY = undefined;
		const {encryptSecret} = await import('./secret-crypto');

		expect(encryptSecret('secret').unwrapErr().kind).toBe('internal_error');
	});
});
