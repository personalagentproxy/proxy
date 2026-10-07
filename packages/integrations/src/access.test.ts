import {describe, expect, test} from 'bun:test';

import {allowsWrite, effectiveAccess, minAccess, providerAccess} from './access';
import {findCollection, findIntegration} from './catalog';
import type {Collection} from './types';

function collection(integrationId: string, collectionId: string): Collection {
	const integration = findIntegration(integrationId);
	const found = integration && findCollection(integration, collectionId);
	if (!found) {
		throw new Error(`No collection ${integrationId}/${collectionId}`);
	}
	return found;
}

describe('providerAccess', () => {
	test('received emails can only be read', () => {
		expect(providerAccess(collection('email', 'emails'))).toBe('read');
	});

	test('drafts can be written', () => {
		expect(providerAccess(collection('email', 'drafts'))).toBe('write');
	});
});

describe('allowsWrite', () => {
	test('a collection without a list takes every change', () => {
		expect(allowsWrite(collection('email', 'drafts'), 'delete')).toBe(true);
	});

	test('a sent email can be sent, never changed', () => {
		const sent = collection('email', 'sent');
		expect(providerAccess(sent)).toBe('write');
		expect(allowsWrite(sent, 'create')).toBe(true);
		expect(allowsWrite(sent, 'update')).toBe(false);
		expect(allowsWrite(sent, 'delete')).toBe(false);
	});
});

describe('effectiveAccess', () => {
	test('an agent without its own setting follows the default', () => {
		expect(effectiveAccess({provider: 'write', connectionDefault: 'read', agent: null})).toBe(
			'read',
		);
	});

	test("an agent's own setting wins over the default", () => {
		expect(effectiveAccess({provider: 'write', connectionDefault: 'read', agent: 'none'})).toBe(
			'none',
		);
		expect(effectiveAccess({provider: 'write', connectionDefault: 'none', agent: 'write'})).toBe(
			'write',
		);
	});

	test('the provider caps both', () => {
		expect(effectiveAccess({provider: 'read', connectionDefault: 'write', agent: null})).toBe(
			'read',
		);
		expect(effectiveAccess({provider: 'read', connectionDefault: 'read', agent: 'write'})).toBe(
			'read',
		);
	});
});

test('minAccess', () => {
	expect(minAccess('write', 'read')).toBe('read');
	expect(minAccess('none', 'write')).toBe('none');
});
