import {describe, expect, test} from 'bun:test';

import {findCollection, findIntegration, type Collection} from '@proxy/integrations';

import {parseRecordValues} from './record-values';

function collection(integrationId: string, collectionId: string): Collection {
	const integration = findIntegration(integrationId);
	const found = integration && findCollection(integration, collectionId);
	if (!found) {
		throw new Error(`No collection ${integrationId}/${collectionId}`);
	}
	return found;
}

describe('parseRecordValues', () => {
	test('keeps the typed-in fields and fills the missing ones with empty strings', () => {
		const result = parseRecordValues(collection('info', 'notes'), {title: 'Sizes'});
		expect(result.unwrap()).toEqual({title: 'Sizes', body: ''});
	});

	test('refuses fields the collection does not have', () => {
		const result = parseRecordValues(collection('info', 'notes'), {title: 'Sizes', color: 'red'});
		expect(result.unwrapErr().kind).toBe('validation_error');
	});

	test('refuses fields the provider sets', () => {
		const result = parseRecordValues(collection('email', 'emails'), {from: 'someone@example.com'});
		expect(result.unwrapErr().kind).toBe('validation_error');
	});

	test('refuses values that are not strings', () => {
		const result = parseRecordValues(collection('info', 'notes'), {title: 3});
		expect(result.unwrapErr().kind).toBe('parse_error');
	});
});
