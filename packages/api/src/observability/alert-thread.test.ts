import {describe, expect, it} from 'bun:test';

import type {LokiStream} from '@proxy/observability';

import {collectOrgIds, formatThreadBody, nameOrganizations, summarizeLokiStreams} from './alert-thread';

function stream(service: string, lines: unknown[]): LokiStream {
	return {
		stream: {service, env: 'production', level: 'error'},
		values: lines.map((line, i) => [String(i), typeof line === 'string' ? line : JSON.stringify(line)]),
	};
}

describe('summarizeLokiStreams', () => {
	it('groups lines by service and message, with the distinct values of their fields', () => {
		const summary = summarizeLokiStreams([
			stream('api', [
				{msg: 'request failed', kind: 'db_error', orgId: 'o1', requestId: 'r1', level: 'error'},
				{msg: 'request failed', kind: 'db_error', orgId: 'o2', requestId: 'r2', level: 'error'},
				{msg: 'other', orgId: 'o1'},
			]),
			stream('web', ['not json at all']),
		]);
		expect(summary.totalLines).toBe(4);
		expect(summary.groups.map((g) => [g.service, g.msg, g.count])).toEqual([
			['api', 'request failed', 2],
			['api', 'other', 1],
			['web', 'not json at all', 1],
		]);
		const failed = summary.groups[0]!;
		expect(Array.from(failed.fields.get('kind')!.values)).toEqual(['db_error']);
		expect(Array.from(failed.fields.get('orgId')!.values)).toEqual(['o1', 'o2']);
		expect(failed.fields.has('level')).toBe(false);
	});

	it('caps the groups and the values per field', () => {
		const lines = Array.from({length: 60}, (_, i) => ({msg: `m${i % 12}`, requestId: `r${i}`}));
		const summary = summarizeLokiStreams([stream('api', lines)], {maxGroups: 5, maxValuesPerField: 2});
		expect(summary.groups).toHaveLength(5);
		expect(summary.omittedGroups).toBe(7);
		const ids = summary.groups[0]!.fields.get('requestId')!;
		expect(ids.values.size).toBe(2);
		expect(ids.truncated).toBe(true);
	});
});

describe('the thread body', () => {
	it('names organizations and lists each group with its fields', () => {
		const summary = summarizeLokiStreams([
			stream('api', [
				{msg: 'request failed', kind: 'db_error', orgId: 'o1'},
				{msg: 'request failed', kind: 'db_error', orgId: 'o2'},
			]),
		]);
		expect(collectOrgIds(summary)).toEqual(['o1', 'o2']);
		nameOrganizations(summary, new Map([['o1', 'acme']]));
		expect(formatThreadBody(summary)).toBe(['*2 log lines* in *1 group*', '', '*2×* `request failed` _(api)_', '  • *kind:* db_error', '  • *org:* acme, o2'].join('\n'));
	});

	it('counts past three values, and says when there were none', () => {
		const summary = summarizeLokiStreams([
			stream(
				'api',
				['a', 'b', 'c', 'd'].map((id) => ({msg: 'x', orgId: id})),
			),
		]);
		expect(formatThreadBody(summary)).toContain('*orgId:* 4 distinct (a, b, c, …)');
		expect(formatThreadBody({groups: [], totalLines: 0, omittedGroups: 0})).toBe('_No matching log lines in the window._');
	});

	it('stays within a Slack block', () => {
		const lines = Array.from({length: 10}, (_, i) => ({msg: 'x'.repeat(400) + i}));
		const body = formatThreadBody(summarizeLokiStreams([stream('api', lines)]));
		expect(body.length).toBeLessThanOrEqual(2900);
		expect(body.endsWith('_…truncated_')).toBe(true);
	});
});
