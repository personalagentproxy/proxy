import {describe, expect, it} from 'bun:test';

import {planPersonalOrgIdentity} from './provision';
import {MEMBER_CONNECTIONS, NAMED_AFTER_ORGANIZATION} from './starter-connections';

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
	it('are a vault of the member’s own, the owner’s as anyone’s, which agents read and write by default; the vaults and the sandboxes are named after the organization', () => {
		expect(MEMBER_CONNECTIONS).toEqual([{integrationId: 'vault', defaults: ['readEntries', 'writeEntries']}]);
		expect(NAMED_AFTER_ORGANIZATION).toEqual(['vault', 'sandbox']);
	});
});
