import {describe, expect, it} from 'bun:test';

import {isChatModel, personaChatModel, toChatModel} from './chat-models';

describe('personaChatModel', () => {
	it('gives a persona of an insider the model chosen for it', () => {
		expect(personaChatModel({insider: true, chatModel: 'glm'})).toBe('glm');
	});

	it('gives a persona of an insider Claude for a model that is no longer one', () => {
		expect(personaChatModel({insider: true, chatModel: 'dropped-long-ago'})).toBe('claude');
	});

	it('gives Claude to a persona of an organization that is not an insider, whatever was chosen before', () => {
		expect(personaChatModel({insider: false, chatModel: 'glm'})).toBe('claude');
	});
});

describe('toChatModel', () => {
	it('keeps a model there is and falls back to Claude for one there is not', () => {
		expect(toChatModel('glm')).toBe('glm');
		expect(toChatModel('dropped-long-ago')).toBe('claude');
	});
});

describe('isChatModel', () => {
	it('does not take what every object has', () => {
		expect(isChatModel('toString')).toBe(false);
	});
});
