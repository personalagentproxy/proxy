import {describe, expect, test} from 'bun:test';
import {readdirSync, readFileSync} from 'node:fs';
import {join} from 'node:path';

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
		expect(intent.WIDGET_IDS).toEqual(ids);
		for (const widget of intent.WIDGETS) {
			const fields = widget.fields.map((field) => field.id);
			expect(new Set(fields).size).toBe(fields.length);
		}
		expect(ids).not.toContain(intent.NO_WIDGET);
		expect(ids).not.toContain(intent.INCOMPLETE);
		const answers: Array<intent.Picked['widget']> = [...ids, intent.NO_WIDGET, intent.INCOMPLETE];
		for (const widget of answers) {
			expect(intent.pickedSchema.parse({widget, ms: 1}).widget).toBe(widget);
		}
		expect(intent.pickedSchema.safeParse({widget: 'nope', ms: 1}).success).toBe(false);
	});

	test('intent offers a widget behind an experiment only to an organization with it on', () => {
		const offered = (experiments: Parameters<typeof intent.offeredWidgets>[0]['experiments']) =>
			intent.offeredWidgets({experiments}).map((widget) => widget.id);
		expect(offered([])).not.toContain('ask');
		expect(offered(['ask'])).toContain('ask');
	});
});
