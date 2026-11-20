import type {Prisma} from '@prisma/client';
import {z} from 'zod';

/**
 * A change's exact inverse (schema.prisma FileChange `undo`), kept with the change where one
 * exists: what undoing it puts back, and what the change left, so that an undo can first check
 * nothing else changed it since. Stored as JSON and read back through `parseFileUndo`, as a row may
 * hold what this server doesn't know: one written by a newer server, of a kind added since. Each
 * kind is told apart by `kind`; a change with none is undone by giving back the version from
 * before it.
 */

/**
 * One cell of a Sheet as it was entered: a formula, a value, or nothing. A formula and a text that
 * merely starts with `=` are told apart, so that writing a cell back gives it exactly as it was.
 */
export const sheetCellSchema = z.union([
	z.null(),
	z.object({formula: z.string()}),
	z.object({value: z.union([z.string(), z.number(), z.boolean()])}),
]);

export type SheetCell = z.infer<typeof sheetCellSchema>;

const cellRowsSchema = z.array(z.array(sheetCellSchema));

function sameShape(before: SheetCell[][], after: SheetCell[][]): boolean {
	return (
		before.length === after.length &&
		before.every((row, index) => row.length === after[index]?.length)
	);
}

/**
 * A range of a Sheet's cells written: the tab by its id, which a rename leaves as it is, and by its
 * name then; the range in A1 notation inside the tab, as `B2:D4`; and its cells row by row, every
 * row as wide as the range, as they were before the write and as the write left them.
 */
export const sheetsCellsUndoSchema = z
	.object({
		kind: z.literal('sheets_cells'),
		sheetId: z.number().int(),
		tab: z.string(),
		range: z.string().min(1),
		before: cellRowsSchema,
		after: cellRowsSchema,
	})
	.refine((undo) => sameShape(undo.before, undo.after), {
		message: 'The cells before and after are not the same shape.',
	});

export const fileUndoSchema = z.discriminatedUnion('kind', [sheetsCellsUndoSchema]);

export type FileUndo = z.infer<typeof fileUndoSchema>;

/** A change's stored inverse as one this server knows; null for none, and for one it doesn't. */
export function parseFileUndo(stored: Prisma.JsonValue): FileUndo | null {
	if (stored === null) {
		return null;
	}
	const parsed = fileUndoSchema.safeParse(stored);
	return parsed.success ? parsed.data : null;
}
