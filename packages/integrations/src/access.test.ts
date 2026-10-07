import {describe, expect, test} from 'bun:test';

import {effectiveActions, matchingPreset, presetsOf, requiredAction} from './access';
import {findCollection, findIntegration, INTEGRATIONS} from './catalog';
import type {Collection} from './types';

function collection(integrationId: string, collectionId: string): Collection {
	const integration = findIntegration(integrationId);
	const found = integration && findCollection(integration, collectionId);
	if (!found) {
		throw new Error(`No collection ${integrationId}/${collectionId}`);
	}
	return found;
}

const drafts = collection('email', 'drafts');

test('every collection starts with read, and its writes and commands name its own actions', () => {
	for (const integration of INTEGRATIONS) {
		for (const each of integration.collections) {
			const ids = each.actions.map((action) => action.id);
			expect(ids[0]).toBe('read');
			const needed = [
				...Object.values(each.writes),
				...(each.commands ?? []).map((command) => command.action),
				...(each.presets ?? []).flatMap((preset) => preset.actions),
			];
			expect(needed.filter((id) => !ids.includes(id))).toEqual([]);
		}
	}
});

describe('effectiveActions', () => {
	test('an agent without its own settings follows the default', () => {
		expect(effectiveActions(drafts, ['read', 'write'])).toEqual(['read', 'write']);
	});

	test("an agent's own setting wins over the default, one action at a time", () => {
		expect(effectiveActions(drafts, ['read', 'write'], {write: false})).toEqual(['read']);
		expect(effectiveActions(drafts, ['read'], {write: true})).toEqual(['read', 'write']);
	});

	test('nothing counts without read', () => {
		expect(effectiveActions(drafts, ['read', 'write'], {read: false})).toEqual([]);
		expect(effectiveActions(drafts, ['write'])).toEqual([]);
	});

	test('an action the catalog no longer has is dropped', () => {
		expect(effectiveActions(drafts, ['read', 'gone'])).toEqual(['read']);
	});
});

describe('presets', () => {
	test('one per set of actions, from No access to everything', () => {
		expect(presetsOf(collection('info', 'cards')).map((preset) => preset.label)).toEqual([
			'No access',
			'Read',
			'Read & write',
		]);
	});

	test("a collection's own presets sit between Read and Full access", () => {
		expect(presetsOf(collection('email', 'emails')).map((preset) => preset.label)).toEqual([
			'No access',
			'Read',
			'Read & triage',
			'Full access',
		]);
	});

	test('actions that match no preset are Custom', () => {
		expect(matchingPreset(drafts, ['read', 'write'])?.label).toBe('Read & write');
		expect(matchingPreset(drafts, ['write'])).toBeNull();
	});
});

describe('requiredAction', () => {
	test("reading needs read, writing the collection's own action", () => {
		expect(requiredAction(drafts, 'list')).toBe('read');
		expect(requiredAction(drafts, 'update')).toBe('write');
	});

	test('a command needs its action, several commands sharing one', () => {
		const emails = collection('email', 'emails');
		expect(requiredAction(emails, 'markRead')).toBe('mark');
		expect(requiredAction(emails, 'markUnread')).toBe('mark');
		expect(requiredAction(drafts, 'send')).toBe('send');
	});

	test('what a collection does not offer needs an action nobody has', () => {
		expect(requiredAction(collection('email', 'emails'), 'create')).toBeNull();
		expect(requiredAction(drafts, 'nonsense')).toBeNull();
	});
});
