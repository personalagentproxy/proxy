import {describe, expect, test} from 'bun:test';

import {hashVerificationToken, secretCipher} from './secret-crypto';

const cipher = secretCipher(Buffer.alloc(32, 7));
const other = secretCipher(Buffer.alloc(32, 8));

describe('secret cipher', () => {
	test('decrypts what it encrypted', () => {
		const secret = '{"password":"abcd efgh ijkl mnop"}';
		const stored = cipher.encrypt(secret);

		expect(stored.startsWith('v1.')).toBe(true);
		// Neither as it is nor encoded: a whole value, since a few letters of it turn up by chance in
		// the random characters of what is stored.
		const body = Buffer.from(stored.split('.')[3] ?? '', 'base64url');
		expect(body.includes(secret)).toBe(false);
		expect(stored).not.toContain(secret);
		expect(stored).not.toContain(Buffer.from(secret).toString('base64url'));
		expect(cipher.decrypt(stored).unwrap()).toBe(secret);
	});

	test('encrypts the same value differently each time', () => {
		expect(cipher.encrypt('secret')).not.toBe(cipher.encrypt('secret'));
	});

	test('fails under another key', () => {
		expect(other.decrypt(cipher.encrypt('secret')).isErr()).toBe(true);
	});

	test('fails when the ciphertext was changed', () => {
		const [version, iv, tag] = cipher.encrypt('secret').split('.');
		const forged = [version, iv, tag, Buffer.from('public').toString('base64url')].join('.');

		expect(cipher.decrypt(forged).isErr()).toBe(true);
	});

	test('fails with a shortened tag, though it is the start of the right one', () => {
		const [version, iv, tag, ciphertext] = cipher.encrypt('secret').split('.');
		const shortTag = Buffer.from(tag ?? '', 'base64url')
			.subarray(0, 4)
			.toString('base64url');

		expect(cipher.decrypt([version, iv, shortTag, ciphertext].join('.')).isErr()).toBe(true);
	});

	test('fails on what is not a stored secret', () => {
		expect(cipher.decrypt('plain').isErr()).toBe(true);
	});
});

describe('hashVerificationToken', () => {
	test('is the token hashed with the secret, the same each time', () => {
		expect(hashVerificationToken('token', 'secret')).toBe(hashVerificationToken('token', 'secret'));
		expect(hashVerificationToken('token', 'secret')).not.toBe(
			hashVerificationToken('token', 'other'),
		);
		expect(hashVerificationToken('token', 'secret')).toMatch(/^[0-9a-f]{64}$/);
	});
});
