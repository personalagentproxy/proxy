import {describe, expect, test} from 'bun:test';

import {INTEGRATIONS} from './catalog';

describe('catalog', () => {
	test('lists high-risk actions last in every group of every integration, as every page shows them in this order', () => {
		for (const integration of INTEGRATIONS) {
			const groups = [...new Set(integration.actions.map((action) => action.group))];
			for (const group of groups) {
				const actions = integration.actions.filter((action) => action.group === group);
				const firstHigh = actions.findIndex((action) => action.risk === 'high');
				if (firstHigh === -1) {
					continue;
				}
				const after = actions.slice(firstHigh).map((action) => action.risk);
				expect(
					after,
					`${integration.id} has a lower-risk action after a high-risk one in ${group ?? 'its actions'}`,
				).toEqual(after.map(() => 'high'));
			}
		}
	});

	// The home page's widgets read these collections by their ids from every integration that has
	// them (all of a person's mailboxes, every calendar), so their fields are one contract. Other
	// ids may mean different things: Granola's notes aren't a note collection of any other.
	test('gives the collections the widgets read the same fields in every integration', () => {
		const read = ['emails', 'events', 'contacts', 'files'];
		const collections = INTEGRATIONS.flatMap((integration) =>
			integration.collections
				.filter((collection) => read.includes(collection.id))
				.map((collection) => ({integration: integration.id, collection})),
		);
		for (const {integration, collection} of collections) {
			const first = collections.find((candidate) => candidate.collection.id === collection.id);
			expect(
				collection.fields.map((field) => [field.key, field.type]),
				`${integration}'s ${collection.id} differs from ${first?.integration}'s`,
			).toEqual(first?.collection.fields.map((field) => [field.key, field.type]) ?? []);
		}
		expect(collections.filter(({collection}) => collection.id === 'emails')).toHaveLength(2);
	});
});
