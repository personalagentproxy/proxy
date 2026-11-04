import {describe, expect, test} from 'bun:test';

import {alertArgs, describeCriteria, matches, parseCriteria, type PollItem} from './alerts';

const now = new Date('2026-11-03T10:00:00Z');

describe('alertArgs', () => {
	test('a timed alert: at a time ahead, within a year', () => {
		const spec = alertArgs(
			{title: ' Dentist ', brief: 'Leave at 8.', at: '2026-11-04T07:30:00-07:00'},
			now,
		);
		expect(spec.unwrap()).toEqual({
			kind: 'time',
			title: 'Dentist',
			brief: 'Leave at 8.',
			at: new Date('2026-11-04T14:30:00Z'),
		});
	});

	test('a time a moment ago is now; one further back, or more than a year ahead, is refused', () => {
		const soon = alertArgs({title: 'T', brief: 'B', at: '2026-11-03T09:59:30Z'}, now).unwrap();
		expect(soon.kind === 'time' && soon.at).toEqual(now);
		expect(
			alertArgs({title: 'T', brief: 'B', at: '2026-11-03T09:00:00Z'}, now).unwrapErr(),
		).toContain('in the past');
		expect(
			alertArgs({title: 'T', brief: 'B', at: '2028-01-01T00:00:00Z'}, now).unwrapErr(),
		).toContain('a year');
		expect(alertArgs({title: 'T', brief: 'B', at: 'tomorrow'}, now).unwrapErr()).toContain(
			'ISO 8601',
		);
	});

	test('a watch: a collection, the connections where given, and criteria on the collection’s fields', () => {
		const spec = alertArgs(
			{
				title: 'Bank',
				brief: 'Mail from the bank about the loan.',
				collection: 'emails',
				connections: ['c1', 'c1', 'c2'],
				match: [
					{field: 'from', terms: ['@bank.com']},
					{field: 'subject', terms: [' loan ', 'mortgage']},
				],
			},
			now,
		);
		expect(spec.unwrap()).toEqual({
			kind: 'watch',
			title: 'Bank',
			brief: 'Mail from the bank about the loan.',
			collectionId: 'emails',
			connectionIds: ['c1', 'c2'],
			criteria: [
				{field: 'from', terms: ['@bank.com']},
				{field: 'subject', terms: ['loan', 'mortgage']},
			],
		});
		const everything = alertArgs(
			{title: 'Issues', brief: 'Every new issue.', collection: 'issues'},
			now,
		).unwrap();
		expect(everything).toMatchObject({
			kind: 'watch',
			collectionId: 'issues',
			connectionIds: null,
			criteria: [],
		});
	});

	test('what is missing, both at once, an unknown collection or field, or empty terms is refused, saying what to give', () => {
		expect(alertArgs(null, now).unwrapErr()).toContain('title');
		expect(alertArgs({title: '', brief: 'B', collection: 'emails'}, now).unwrapErr()).toContain(
			'title',
		);
		expect(alertArgs({title: 'T', brief: ' ', collection: 'emails'}, now).unwrapErr()).toContain(
			'brief',
		);
		expect(alertArgs({title: 'T', brief: 'B'}, now).unwrapErr()).toContain('collection');
		expect(
			alertArgs(
				{title: 'T', brief: 'B', at: '2026-11-04T10:00:00Z', collection: 'emails'},
				now,
			).unwrapErr(),
		).toContain('not both');
		expect(alertArgs({title: 'T', brief: 'B', collection: 'files'}, now).unwrapErr()).toContain(
			'emails, issues, events',
		);
		expect(
			alertArgs(
				{title: 'T', brief: 'B', collection: 'emails', match: [{field: 'status', terms: ['Done']}]},
				now,
			).unwrapErr(),
		).toContain('from, to, subject, snippet, any');
		expect(
			alertArgs(
				{title: 'T', brief: 'B', collection: 'emails', match: [{field: 'from', terms: []}]},
				now,
			).unwrapErr(),
		).toContain('terms');
		expect(
			alertArgs({title: 'T', brief: 'B', collection: 'emails', connections: 'c1'}, now).unwrapErr(),
		).toContain('connections');
	});
});

describe('matches', () => {
	const item: PollItem = {
		recordId: 'm1',
		title: 'Your loan application',
		url: null,
		at: '2026-11-03T10:00:00Z',
		fields: {from: 'Dana <dana@bank.com>', to: 'me@example.com', subject: 'Your LOAN application'},
	};

	test('every condition holds, any of its terms, case-insensitive; any searches every field', () => {
		expect(
			matches(
				[
					{field: 'from', terms: ['@bank.com']},
					{field: 'subject', terms: ['mortgage', 'loan']},
				],
				item,
			),
		).toBe(true);
		expect(
			matches(
				[
					{field: 'from', terms: ['@bank.com']},
					{field: 'subject', terms: ['mortgage']},
				],
				item,
			),
		).toBe(false);
		expect(matches([{field: 'any', terms: ['dana']}], item)).toBe(true);
		expect(matches([{field: 'snippet', terms: ['loan']}], item)).toBe(false);
		expect(matches([], item)).toBe(true);
	});
});

test('criteria are kept as JSON and read back, anything else as none', () => {
	expect(parseCriteria('[{"field":"from","terms":["a",1]}]')).toEqual([
		{field: 'from', terms: ['a']},
	]);
	expect(parseCriteria('nope')).toEqual([]);
	expect(parseCriteria(null)).toEqual([]);
});

test('criteria read in words', () => {
	expect(describeCriteria([])).toBe('anything new');
	expect(
		describeCriteria([
			{field: 'from', terms: ['@bank.com']},
			{field: 'subject', terms: ['loan', 'mortgage', 'rate']},
			{field: 'any', terms: ['urgent']},
		]),
	).toBe(
		'from contains “@bank.com”, and subject contains “loan”, “mortgage” or “rate”, and any field contains “urgent”',
	);
});
