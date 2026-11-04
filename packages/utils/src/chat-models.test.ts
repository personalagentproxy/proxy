import {describe, expect, it} from 'bun:test';

import {isChatModel, organizationChatModel} from './chat-models';

describe('organizationChatModel', () => {
	it('gives an insider the model it chose', () => {
		expect(organizationChatModel({insider: true, chatModel: 'glm'})).toBe('glm');
	});

	it('gives an insider Claude for a model that is no longer one', () => {
		expect(organizationChatModel({insider: true, chatModel: 'dropped-long-ago'})).toBe('claude');
	});

	it('gives no choice to an organization that is not an insider, whatever it chose before', () => {
		expect(organizationChatModel({insider: false, chatModel: 'glm'})).toBeNull();
	});
});

describe('isChatModel', () => {
	it('does not take what every object has', () => {
		expect(isChatModel('toString')).toBe(false);
	});
});
