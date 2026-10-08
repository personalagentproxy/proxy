import {describe, expect, test} from 'bun:test';

import {INTEGRATIONS} from './catalog';

describe('catalog', () => {
	test('lists high-risk actions last in every integration, as every page shows them in this order', () => {
		for (const integration of INTEGRATIONS) {
			const firstHigh = integration.actions.findIndex((action) => action.risk === 'high');
			if (firstHigh === -1) {
				continue;
			}
			const after = integration.actions.slice(firstHigh).map((action) => action.risk);
			expect(after, `${integration.id} has a lower-risk action after a high-risk one`).toEqual(
				after.map(() => 'high'),
			);
		}
	});
});
