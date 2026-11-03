import {describe, expect, it} from 'bun:test';

import {planPersonalOrgIdentity} from './provision';
import {MEMBER_CONNECTIONS, NAMED_AFTER_ORGANIZATION, ORGANIZATION_CONNECTIONS} from './starter-connections';

describe('planPersonalOrgIdentity', () => {
	it('names the organization after the first name', () => {
		expect(planPersonalOrgIdentity({name: 'Ann Lee', email: 'ann@example.com'})).toEqual({
			name: "Ann's Workspace",
			slugSource: "Ann's Workspace",
		});
	});

	it('falls back to the email when there is no name', () => {
		expect(planPersonalOrgIdentity({name: null, email: 'ann.lee@example.com'}).name).toBe("ann.lee's Workspace");
	});

	it('keeps a non-Latin name but takes the slug from the email', () => {
		expect(planPersonalOrgIdentity({name: 'Алексей', email: 'alex@example.com'})).toEqual({
			name: "Алексей's Workspace",
			slugSource: "alex's Workspace",
		});
	});
});

describe('the starter connections', () => {
	it('are the owner’s own vault and the shared one, agents reading and writing each by default; a member gets their own', () => {
		expect(ORGANIZATION_CONNECTIONS).toEqual([
			{integrationId: 'vault', shared: false, defaults: ['readEntries', 'writeEntries']},
			{integrationId: 'vault', shared: true, defaults: ['readEntries', 'writeEntries']},
		]);
		expect(MEMBER_CONNECTIONS).toEqual([{integrationId: 'vault', shared: false, defaults: ['readEntries', 'writeEntries']}]);
		expect(NAMED_AFTER_ORGANIZATION).toEqual(['vault']);
	});
});
