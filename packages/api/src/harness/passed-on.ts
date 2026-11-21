import type {Result} from 'ts-results-es';

import {type ApiError, Do} from '@proxy/utils';
import {passedOnText} from '@proxy/utils/harness-context';
import type {EntryRow} from '@proxy/db/harness';

import type {HarnessStore} from './store';

/**
 * The entries as the model reads them, what the person said that another of their threads passed
 * on to this one led in as theirs, from that thread, by its title as it is now, or from one deleted
 * since (@proxy/utils/harness-context passedOnText); the rest as they are. Whichever harness runs
 * the turn is given the log with it written in (inference.ts), and so is a turn given what came in
 * as it ran (tool-surface.ts). Nothing is read where nothing was passed on.
 */
export function withPassedOnLeads(store: Pick<HarnessStore, 'listPassedOnThreads'>, entries: EntryRow[]): Promise<Result<EntryRow[], ApiError>> {
	return Do(async ($) => {
		const ids = entries.flatMap((entry) => (entry.kind === 'person' && entry.passedOnFromId !== null ? [entry.passedOnFromId] : []));
		if (ids.length === 0) {
			return entries;
		}
		const threads = $(await store.listPassedOnThreads(ids));
		return entries.map((entry) => {
			if (entry.kind !== 'person' || entry.passedOnFromId === null) {
				return entry;
			}
			const from = threads.find((thread) => thread.id === entry.passedOnFromId) ?? null;
			return {...entry, text: passedOnText(entry.text, from)};
		});
	});
}
