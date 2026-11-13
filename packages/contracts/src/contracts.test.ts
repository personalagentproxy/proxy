import {describe, expect, test} from 'bun:test';
import {readdirSync, readFileSync} from 'node:fs';
import {join} from 'node:path';

import * as harness from './harness';
import * as intent from './intent';
import * as widgets from './widgets';

// What a contract may import: zod, the shared packages the web app takes too, and other contracts.
const ALLOWED = /^(zod|@proxy\/utils(\/.*)?|@proxy\/integrations|\.\.?\/.*)$/;

const SOURCES = readdirSync(import.meta.dir).filter(
	(file) => file.endsWith('.ts') && !file.endsWith('.test.ts'),
);

// Every module a file imports or re-exports from, statically or dynamically.
function importsOf(text: string): string[] {
	const found = [
		...text.matchAll(/\b(?:import|export)\b[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]/g),
		...text.matchAll(/\bimport\s*['"]([^'"]+)['"]/g),
		...text.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g),
	];
	return found.flatMap((match) => (match[1] === undefined ? [] : [match[1]]));
}

describe('contracts', () => {
	test.each(SOURCES)(
		'%s imports only zod, @proxy/utils, @proxy/integrations or a contract',
		(file) => {
			const imports = importsOf(readFileSync(join(import.meta.dir, file), 'utf8'));
			expect(imports.filter((one) => !ALLOWED.test(one))).toEqual([]);
		},
	);

	test('the import check sees every kind of import', () => {
		const text = [
			"import {z} from 'zod';",
			"import type {Viewer} from '@proxy/db/viewer';",
			"export {thing} from '../server/thing';",
			"import 'node:fs';",
			"const later = import('@proxy/db');",
		].join('\n');
		expect(importsOf(text)).toEqual([
			'zod',
			'@proxy/db/viewer',
			'../server/thing',
			'node:fs',
			'@proxy/db',
		]);
	});

	test('widgets has a schema for every answer the web app asks for, and for the bodies it sends', () => {
		const schemas = [
			widgets.peopleSchema,
			widgets.agendaSchema,
			widgets.foundEventsSchema,
			widgets.madeEventSchema,
			widgets.foundEmailsSchema,
			widgets.writtenEmailSchema,
			widgets.mailboxesSchema,
			widgets.foundFilesSchema,
			widgets.foundMeetingsSchema,
			widgets.foundRecordsSchema,
			widgets.answerSchema,
			widgets.dayRatesSchema,
			widgets.bankAccountsSchema,
			widgets.bankTransactionsSchema,
			widgets.newEventBodySchema,
			widgets.eventChangeBodySchema,
			widgets.newEmailBodySchema,
			widgets.emailReplyBodySchema,
			widgets.askBodySchema,
		];
		for (const schema of schemas) {
			expect(typeof schema.safeParse).toBe('function');
		}
		expect(widgets.failureSchema.parse({connectionId: 'c', account: 'a', message: 'm'})).toEqual({
			connectionId: 'c',
			account: 'a',
			message: 'm',
		});
	});

	test('intent lists every widget once, each field once within it, and answers only their ids', () => {
		const ids = intent.WIDGETS.map((widget) => widget.id);
		expect(new Set(ids).size).toBe(ids.length);
		expect([...intent.WIDGET_IDS]).toEqual(ids);
		for (const widget of intent.WIDGETS) {
			expect(intent.WIDGET_NAMES[widget.id]).toBe(widget.name);
		}
		for (const widget of intent.WIDGETS) {
			const fields = widget.fields.map((field) => field.id);
			expect(new Set(fields).size).toBe(fields.length);
		}
		expect([...intent.FIELD_IDS].sort()).toEqual(
			[
				...new Set(intent.WIDGETS.flatMap((widget) => widget.fields.map((field) => field.id))),
			].sort(),
		);
		expect(ids).not.toContain(intent.NO_WIDGET);
		expect(ids).not.toContain(intent.INCOMPLETE);
		const answers: Array<intent.Picked['widget']> = [...ids, intent.NO_WIDGET, intent.INCOMPLETE];
		for (const widget of answers) {
			expect(intent.pickedSchema.parse({widget, ms: 1}).widget).toBe(widget);
		}
		expect(intent.pickedSchema.safeParse({widget: 'nope', ms: 1}).success).toBe(false);
	});

	test('a chat thread says where it stands, one of the three words, and its summary, or null', () => {
		const thread: harness.ChatThread = {
			id: 't1',
			title: 'Add a date filter to the activity log',
			state: {kind: 'stopped'},
			standing: 'waiting',
			standingPending: false,
			opener: {
				kind: 'person',
				text: 'add a date filter to the activity log, plan first',
				attachments: [],
			},
			summary: 'Has a plan, and asks whether the date range should cover the CSV export too.',
			latest: 'I have a plan, and one question before I build.',
			latestEntryId: 'e2',
			latestAnswerId: 'e2',
			messageCount: 2,
			lastMessageAt: '2026-03-02T09:24:00.000Z',
		};
		expect(harness.chatThreadSchema.parse(thread)).toEqual(thread);
		expect(
			harness.chatThreadSchema.parse({...thread, standing: 'done', summary: null}).summary,
		).toBeNull();
		expect([...harness.threadStandingSchema.options]).toEqual(['in_progress', 'waiting', 'done']);
		expect(harness.chatThreadSchema.safeParse({...thread, standing: 'stopped'}).success).toBe(
			false,
		);
		const {summary: _summary, ...withoutSummary} = thread;
		expect(harness.chatThreadSchema.safeParse(withoutSummary).success).toBe(false);
	});
});
