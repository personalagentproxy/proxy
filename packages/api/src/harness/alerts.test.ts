import {describe, expect, test} from 'bun:test';

import type {AlertRow} from '@proxy/db/harness';

import {alertsParagraph, connectionGoneText, describeAlert, dueText, itemSummary, matchText} from './alerts';

function alert(extra: Partial<AlertRow> = {}): AlertRow {
	return {
		id: 'alert-1',
		orgId: 'org-1',
		agentId: 'agent-1',
		personaId: 'persona-1',
		userId: 'user-1',
		threadId: 'thread-1',
		title: 'Mail from the bank',
		brief: 'Mail from the bank about the loan.',
		at: null,
		collectionId: 'emails',
		connectionIds: ['conn-a'],
		criteria: '[{"field":"from","terms":["@bank.com"]},{"field":"subject","terms":["loan","mortgage"]}]',
		endedAt: null,
		endedBy: null,
		createdAt: new Date('2026-11-03T09:00:00Z'),
		...extra,
	};
}

const timed = alert({title: 'Dentist', brief: 'Tell them to leave for the dentist.', at: new Date('2026-11-04T08:30:00Z'), collectionId: null, connectionIds: [], criteria: null});

describe('what the agent is told of its alerts', () => {
	test('each in a line with its id and what it is, or that there are none', () => {
		expect(describeAlert(timed)).toBe('alert-1: “Dentist”, due 2026-11-04T08:30:00.000Z');
		expect(describeAlert(alert())).toBe('alert-1: “Mail from the bank”, watching emails in connection conn-a for from contains “@bank.com”, and subject contains “loan” or “mortgage”');
		expect(describeAlert(alert({connectionIds: ['conn-a', 'conn-b'], criteria: '[]'}))).toBe('alert-1: “Mail from the bank”, watching emails in connections conn-a, conn-b for anything new');
		expect(alertsParagraph([])).toBe('No alert is set in this conversation.');
		expect(alertsParagraph([timed])).toBe('The alerts set in this conversation, still going, each by the id cancel_alert takes:\n- alert-1: “Dentist”, due 2026-11-04T08:30:00.000Z');
	});

	test('a timed alert due says what was noted for it', () => {
		expect(dueText(timed)).toBe('The alert “Dentist” is due now, which you set for 2026-11-04T08:30:00.000Z. What you noted for it: Tell them to leave for the dentist.');
	});
});

describe('a match', () => {
	test('keeps the record’s fields with something in them, in a line, cut', () => {
		expect(itemSummary({recordId: 'm1', title: 'Loan', url: null, at: '', fields: {from: 'dana@bank.com', to: '', subject: ' Your  loan\napplication '}})).toBe(
			'from: dana@bank.com · subject: Your loan application',
		);
		expect(itemSummary({recordId: 'm1', title: 'Loan', url: null, at: '', fields: {snippet: 'x'.repeat(400)}}).length).toBe(300);
	});

	test('is told with the records, their links and ids, what the watch is for, and the brief', () => {
		const items = [
			{recordId: 'm1', title: 'Your loan', url: 'https://mail.example/m1', at: '2026-11-04T10:00:00Z', fields: {}, summary: 'from: dana@bank.com'},
			{recordId: 'm2', title: 'Your mortgage', url: null, at: '2026-11-04T10:05:00Z', fields: {}, summary: 'from: sam@bank.com'},
		];
		expect(matchText(alert(), items)).toBe(
			[
				'The alert “Mail from the bank” matched 2 new emails it watches, for from contains “@bank.com”, and subject contains “loan” or “mortgage”:',
				'- Your loan (https://mail.example/m1) — from: dana@bank.com; id m1, at 2026-11-04T10:00:00Z\n- Your mortgage — from: sam@bank.com; id m2, at 2026-11-04T10:05:00Z',
				'What you noted for it: Mail from the bank about the loan.',
			].join('\n\n'),
		);
		expect(matchText(alert({collectionId: 'issues'}), items.slice(0, 1))).toContain('matched a new one of the issues it watches');
	});

	test('a connection gone ends the watch, and is told', () => {
		expect(connectionGoneText(alert())).toBe('The alert “Mail from the bank” has ended: the connection it watched is gone. Tell the person; set it again if they want it kept.');
	});
});
