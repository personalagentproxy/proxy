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
		expect(requireListQuery(collection('email', 'emails'), {search: 'from:sam', page: null, filter: 'Draft', parent: null}).isOk()).toBe(true);
		expect(requireListQuery(collection('email', 'emails'), {search: null, page: null, filter: 'Spam', parent: null}).unwrapErr().kind).toBe('validation_error');
	});

	test("refuses a search on a collection that can't be searched", () => {
		const notes = collection('granola', 'notes');
		expect(requireListQuery(notes, {search: null, page: 'cursor', filter: null, parent: null}).isOk()).toBe(true);
		expect(requireListQuery(notes, {search: 'Q3', page: null, filter: null, parent: null}).unwrapErr().kind).toBe('validation_error');
	});

	test('opens a list inside a record only in a nested collection', () => {
		expect(requireListQuery(collection('notion', 'pages'), {search: null, page: null, filter: null, parent: 'page-1'}).isOk()).toBe(true);
		expect(requireListQuery(collection('granola', 'notes'), {search: null, page: null, filter: null, parent: 'note-1'}).unwrapErr().kind).toBe('validation_error');
	});
});
