import type {AuditEntry} from '@proxy/contracts/activity';
import {describe, expect, test} from 'bun:test';
import {describeEntry} from '@/lib/access';

// An entry of a request relayed to GitHub from a sandbox.
function relayed(entry: Partial<AuditEntry>): AuditEntry {
	return {
		id: 'entry-1',
		at: '2026-11-10T10:00:00.000Z',
		agentId: 'agent-1',
		connectionId: 'github-1',
		collectionId: 'git',
		action: 'read',
		recordTitle: 'acme/demo',
		query: null,
		outcome: 'allowed',
		error: null,
		via: 'cli',
		taskId: 'task-1',
		durationMs: 120,
		userId: null,
		userName: null,
		...entry,
	};
}

describe('describeEntry, for requests relayed from a sandbox', () => {
	test('git’s fetches and pushes, by the repository, a push with its refs', () => {
		expect(describeEntry(relayed({}), null)).toBe('Fetched acme/demo');
		expect(describeEntry(relayed({action: 'push', query: 'fix-login'}), null)).toBe(
			'Pushed to acme/demo: fix-login',
		);
		expect(describeEntry(relayed({action: 'push'}), null)).toBe('Pushed to acme/demo');
		expect(describeEntry(relayed({action: 'pushDefault', query: 'main'}), null)).toBe(
			'Pushed to acme/demo: main',
		);
		expect(describeEntry(relayed({action: 'push', outcome: 'denied'}), null)).toBe(
			'Tried to push to acme/demo',
		);
		expect(describeEntry(relayed({outcome: 'failed'}), null)).toBe('Failed to fetch acme/demo');
	});

	test('the API’s requests, by their method and path', () => {
		const api = {collectionId: 'api', query: 'POST /repos/acme/demo/pulls', action: 'contribute'};

		expect(describeEntry(relayed(api), null)).toBe('POST /repos/acme/demo/pulls');
		expect(describeEntry(relayed({...api, outcome: 'denied'}), null)).toBe(
			'Tried POST /repos/acme/demo/pulls',
		);
		expect(
			describeEntry(
				relayed({
					collectionId: 'api',
					query: 'POST /graphql mutation AddComment',
					outcome: 'failed',
				}),
				null,
			),
		).toBe('Failed POST /graphql mutation AddComment');
	});
});
