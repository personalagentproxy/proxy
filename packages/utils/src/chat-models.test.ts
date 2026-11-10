import {describe, expect, it} from 'bun:test';

import {isChatModel} from './chat-models';

describe('isChatModel', () => {
	it('takes a model there is, and not one there is not', () => {
		expect(isChatModel('glm')).toBe(true);
		expect(isChatModel('dropped-long-ago')).toBe(false);
	});

	it('does not take what every object has', () => {
		expect(isChatModel('toString')).toBe(false);
	});
});
