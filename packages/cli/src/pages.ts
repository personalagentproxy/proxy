import {Err, type Result} from 'ts-results-es';

import {Do} from '@proxy/utils/do';

import {type Failure, failed, type Io, isObject, type Json, type JsonObject} from './io';

/**
 * `pap call --all`: every page of a list. A collection's list tool answers `{records, nextPage,
 * trail?}` and takes the `nextPage` back as `page` (@proxy/contracts/records), the vault's and
 * the sandboxes' alike; so the pages are followed, their records put in one list, under the first
 * page's `trail`, with `nextPage` null once the list is done. After MAX_PAGES it stops, the
 * `nextPage` left for a call to go on from, and says so on stderr. An answer of any other shape,
 * such as a custom server's tool's, has no pages to follow and is the result as it is.
 */

export const MAX_PAGES = 20;

type RecordPage = JsonObject & {records: Json[]; nextPage: string | null};

function isRecordPage(value: Json): value is RecordPage {
	return (
		isObject(value) &&
		Array.isArray(value.records) &&
		(typeof value.nextPage === 'string' || value.nextPage === null)
	);
}

export function callAllPages(
	io: Io,
	call: (params: JsonObject) => Promise<Result<Json, Failure>>,
	params: JsonObject,
): Promise<Result<Json, Failure>> {
	return Do(async ($) => {
		const first = $(await call(params));
		if (!isRecordPage(first)) {
			return first;
		}
		const records = [...first.records];
		let next = first.nextPage;
		for (let pages = 1; next !== null; pages++) {
			if (pages === MAX_PAGES) {
				io.err(
					`pap: stopped after ${MAX_PAGES} pages; for more, call again with "page": "${next}".\n`,
				);
				break;
			}
			const page = $(await call({...params, page: next}));
			if (!isRecordPage(page)) {
				return $(Err(failed(`Page ${pages + 1} was not a list page. Call without --all.`)));
			}
			records.push(...page.records);
			next = page.nextPage;
		}
		return {...first, records, nextPage: next};
	});
}
