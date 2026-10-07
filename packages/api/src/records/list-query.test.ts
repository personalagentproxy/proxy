import {describe, expect, test} from 'bun:test';

import {findCollection, findIntegration, type Collection} from '@proxy/integrations';

import {requireListQuery} from './list-query';

function collection(integrationId: string, collectionId: string): Collection {
	const integration = findIntegration(integrationId);
	const found = integration && findCollection(integration, collectionId);
	if (!found) {
		throw new Error(`No ${collectionId} collection`);
	}
	return found;
}

describe('requireListQuery', () => {
	test("takes a search where the collection has one, and its filter field's values", () => {
		expect(requireListQuery(collection('email', 'emails'), {search: 'from:sam', page: null, filter: 'Draft'}).isOk()).toBe(true);
		expect(requireListQuery(collection('email', 'emails'), {search: null, page: null, filter: 'Spam'}).unwrapErr().kind).toBe('validation_error');
	});

	test("refuses a search on a collection that can't be searched", () => {
		const notes = collection('granola', 'notes');
		expect(requireListQuery(notes, {search: null, page: 'cursor', filter: null}).isOk()).toBe(true);
		expect(requireListQuery(notes, {search: 'Q3', page: null, filter: null}).unwrapErr().kind).toBe('validation_error');
	});
});
