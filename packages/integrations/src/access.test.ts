import {describe, expect, test} from 'bun:test';

import {applies, effectiveActions, requiredAction} from './access';
import {findCollection, findIntegration, INTEGRATIONS} from './catalog';
import type {Collection, Integration} from './types';

function integration(id: string): Integration {
	const found = findIntegration(id);
	if (!found) {
		throw new Error(`No integration ${id}`);
	}
	return found;
}

function collection(integrationId: string, collectionId: string): Collection {
	const found = findCollection(integration(integrationId), collectionId);
	if (!found) {
		throw new Error(`No collection ${integrationId}/${collectionId}`);
	}
	return found;
}

const email = integration('email');
const emails = collection('email', 'emails');

test("every read, write, command and requirement names one of the integration's actions", () => {
	for (const each of INTEGRATIONS) {
		const ids = each.actions.map((action) => action.id);
		const named = [
			...each.actions.flatMap((action) => (action.requires ? [action.requires] : [])),
			...each.collections.flatMap((one) => [
				...(one.read ? [one.read] : []),
				...Object.values(one.writes),
				...(one.commands ?? []).map((command) => command.action),
				...one.fields.flatMap((field) => (field.action ? [field.action] : [])),
			]),
		];
		expect(named.filter((id) => !ids.includes(id))).toEqual([]);
	}
});

describe('effectiveActions', () => {
	test('an agent without its own settings follows the default', () => {
		expect(effectiveActions(email, ['read', 'archive'])).toEqual(['read', 'archive']);
	});

	test("an agent's own setting wins over the default, one action at a time", () => {
		expect(effectiveActions(email, ['read', 'archive'], {archive: false})).toEqual(['read']);
		expect(effectiveActions(email, ['read'], {send: true})).toEqual(['read', 'send']);
	});

	test('an action counts only with the one it requires', () => {
		expect(effectiveActions(email, ['read', 'archive'], {read: false})).toEqual([]);
		expect(effectiveActions(integration('vault'), ['writeEntries'])).toEqual([]);
	});

	test('an action counts only while the whole chain under it does', () => {
		const google = integration('google');
		expect(effectiveActions(google, ['readEvents', 'writeEvents', 'inviteGuests'])).toEqual([
			'readEvents',
			'writeEvents',
			'inviteGuests',
		]);
		expect(effectiveActions(google, ['writeEvents', 'inviteGuests'])).toEqual([]);
	});

	test('sending needs nothing else', () => {
		expect(effectiveActions(email, ['send'])).toEqual(['send']);
	});

	test('an action the catalog no longer has is dropped', () => {
		expect(effectiveActions(email, ['read', 'gone'])).toEqual(['read']);
	});

	test("an action the sign-in didn't cover is off whatever is ticked, and so are those requiring it", () => {
		expect(effectiveActions(email, ['read', 'archive'], {}, ['read'])).toEqual([]);
		expect(effectiveActions(email, ['send'], {send: true}, ['send'])).toEqual([]);
		expect(effectiveActions(email, ['read', 'send'], {}, ['send'])).toEqual(['read']);
	});
});

test("an integration's groups each hold their actions together, in one run", () => {
	for (const each of INTEGRATIONS) {
		const groups = each.actions.map((action) => action.group);
		const runs = groups.filter((group, index) => group !== groups[index - 1]);
		expect(runs).toEqual([...new Set(runs)]);
	}
});

describe('requiredAction', () => {
	test("reading needs the collection's read, writing and commands their own action", () => {
		expect(requiredAction(collection('vault', 'entries'), 'list')).toBe('readEntries');
		expect(requiredAction(collection('vault', 'entries'), 'update')).toBe('writeEntries');
		expect(requiredAction(emails, 'markUnread')).toBe('mark');
		expect(requiredAction(emails, 'sendNew')).toBe('send');
	});

	test('what a collection does not offer needs an action nobody has', () => {
		expect(requiredAction(emails, 'nonsense')).toBeNull();
	});
});

test('a condition picks records out by a field', () => {
	const inbox = {field: 'folder', values: ['Inbox']};
	expect(applies(inbox, {folder: 'Inbox'})).toBe(true);
	expect(applies(inbox, {folder: 'Draft'})).toBe(false);
	expect(applies(undefined, {})).toBe(true);
});
