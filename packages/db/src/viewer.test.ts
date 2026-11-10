import {describe, expect, test} from 'bun:test';

import {leavingWith, usableBy, visibleTo} from './viewer';

describe('usableBy', () => {
	test('a member uses their own connections, those shared with them by name and those shared with every member', () => {
		expect(usableBy({orgId: 'org-1', userId: 'user-1'})).toEqual({
			orgId: 'org-1',
			OR: [
				{ownerUserId: 'user-1'},
				{sharedWithEveryone: true, ownerUserId: {not: null}},
				{shares: {some: {userId: 'user-1'}}},
			],
		});
	});

	test('a shared agent uses only the connections shared with every member, never one shared with members by name', () => {
		expect(usableBy({orgId: 'org-1', userId: null})).toEqual({
			orgId: 'org-1',
			sharedWithEveryone: true,
			ownerUserId: {not: null},
		});
	});
});

describe('visibleTo', () => {
	test('a member sees the shared agents, tasks and activity and their own, a shared agent the shared ones alone', () => {
		expect(visibleTo({orgId: 'org-1', userId: 'user-1'})).toEqual({
			orgId: 'org-1',
			OR: [{ownerUserId: null}, {ownerUserId: 'user-1'}],
		});
		expect(visibleTo({orgId: 'org-1', userId: null})).toEqual({
			orgId: 'org-1',
			OR: [{ownerUserId: null}],
		});
	});
});

describe('leavingWith', () => {
	test('a member takes their connections with them but for those shared with every member', () => {
		expect(leavingWith({orgId: 'org-1', userId: 'user-1'})).toEqual({
			orgId: 'org-1',
			ownerUserId: 'user-1',
			sharedWithEveryone: false,
		});
	});
});
