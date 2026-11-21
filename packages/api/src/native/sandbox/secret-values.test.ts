import {describe, expect, test} from 'bun:test';

import {maskSecrets, pickSecret, secretEnv} from './secret-values';

const own = {id: 'vault-1', integrationId: 'vault', account: 'Acme', shared: false, actions: ['useSecrets'], name: null, signInNeeded: false};
const work = {...own, id: 'vault-2', name: 'Work', shared: true};

describe('pickSecret', () => {
	test('finds a name one vault has', () => {
		const held = [{name: 'API_KEY', value: 'sk-one', vault: own}];
		expect(pickSecret(held, 'API_KEY').unwrap()).toEqual({name: 'API_KEY', value: 'sk-one'});
	});

	test('asks which vault where two have the name, and takes one named by its name or id', () => {
		const held = [
			{name: 'API_KEY', value: 'sk-one', vault: own},
			{name: 'API_KEY', value: 'sk-two', vault: work},
		];
		expect(pickSecret(held, 'API_KEY').isErr()).toBe(true);
		expect(pickSecret(held, 'Work/API_KEY').unwrap().value).toBe('sk-two');
		expect(pickSecret(held, 'vault-1/API_KEY').unwrap().value).toBe('sk-one');
		expect(pickSecret(held, 'Vault/API_KEY').unwrap().value).toBe('sk-one');
	});

	test('a name no vault has is not found', () => {
		expect(pickSecret([], 'MISSING').unwrapErr().kind).toBe('not_found');
	});
});

describe('maskSecrets', () => {
	test('shows each value as its name, the longer first', () => {
		const secrets = [
			{name: 'SHORT', value: 'abcd'},
			{name: 'LONG', value: 'abcdefgh'},
		];
		expect(maskSecrets('key=abcdefgh and abcd', secrets)).toBe('key=[secret LONG] and [secret SHORT]');
	});

	test('leaves values too short to tell apart as they are', () => {
		expect(maskSecrets('a b c', [{name: 'TINY', value: 'b'}])).toBe('a b c');
	});
});

test('secretEnv gives each secret by its name', () => {
	expect(secretEnv([{name: 'API_KEY', value: 'sk-one'}])).toEqual({API_KEY: 'sk-one'});
});
