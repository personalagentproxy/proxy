import {beforeEach, describe, expect, mock, test} from 'bun:test';

const mockEnv: {ENCRYPTION_KEY: string | undefined} = {ENCRYPTION_KEY: undefined};

mock.module('./env', () => ({env: mockEnv}));

const KEY = Buffer.alloc(32, 7).toString('base64');
const OTHER_KEY = Buffer.alloc(32, 8).toString('base64');

beforeEach(() => {
	mockEnv.ENCRYPTION_KEY = KEY;
});

// The cipher itself is tested where it is (@proxy/utils/secret-crypto); this is the key it is under.
describe('secret crypto', () => {
	test('decrypts what it encrypted, under ENCRYPTION_KEY', async () => {
		const {encryptSecret, decryptSecret} = await import('./secret-crypto');
		const stored = encryptSecret('secret').unwrap();

		expect(decryptSecret(stored).unwrap()).toBe('secret');
	});

	test('fails, as an internal error, under another key', async () => {
		const {encryptSecret, decryptSecret} = await import('./secret-crypto');
		const stored = encryptSecret('secret').unwrap();
		mockEnv.ENCRYPTION_KEY = OTHER_KEY;

		expect(decryptSecret(stored).unwrapErr().kind).toBe('internal_error');
	});

	test('fails without a key', async () => {
		mockEnv.ENCRYPTION_KEY = undefined;
		const {encryptSecret} = await import('./secret-crypto');

		expect(encryptSecret('secret').unwrapErr().kind).toBe('internal_error');
	});
});
