import {describe, expect, test} from 'bun:test';

import {effectiveAccess, minAccess, providerAccess} from './access';
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
