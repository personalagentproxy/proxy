import type {Result} from 'ts-results-es';
import {z} from 'zod';

import {type ApiError, Do, parseSchema} from '@proxy/utils';
import {type FoundRecord, type FoundRecords, SEARCHED_COLLECTIONS} from '@proxy/contracts/widgets';

import type {AuthenticatedRequest} from '../server/middleware/require-auth';
import {requireViewer} from '../utils/user-org';
import {requireAskExperiment} from './ask-experiment';
import {eachSource} from './each-source';
import {findSources, summarize, type Source} from './sources';

/**
 * Records for the Ask widget from a collection searched as an agent searches it, through its
 * connector: Notion's pages, Linear's issues. Each source's own search orders them; a page's
 * database or view, which has nothing of its own to read, is left out. Mail and files have
 * searches of their own, which know senders, owners and kinds.
 */

// What the widget offers at most, across every source.
const LIMIT = 8;

const querySchema = z.object({
	collection: z.enum(SEARCHED_COLLECTIONS),
	words: z
		.union([z.string(), z.array(z.string())])
		.optional()
		.transform((value) => (value === undefined ? [] : Array.isArray(value) ? value : [value]))
		.transform((values) =>
			values
				.map((one) => one.trim().slice(0, 100))
				.filter((one) => one !== '')
				.slice(0, 10),
		),
});

function searchSource(source: Source, words: string[]): Promise<Result<FoundRecord[], ApiError>> {
	return Do(async ($) => {
		// No words lists what the source lists first: Notion's recent pages, Linear's newest issues.
		const page = $(await source.connector.list(source, {search: words.length > 0 ? words.join(' ') : null, page: null, filter: null, parent: null}));
		return page.records
			.filter((record) => record.values.kind === undefined || record.values.kind === 'Page')
			.map((record) => ({
				connectionId: source.connection.id,
				id: record.id,
				title: record.values[source.collection.titleField] ?? '',
				updated: record.updatedAt,
				link: record.url ?? null,
			}));
	});
}

/** `GET /api/widgets/records?collection=…&words=…`: the records each source's search finds. */
export function handleFindRecordsRoute(request: AuthenticatedRequest): Promise<Result<FoundRecords, ApiError>> {
	return Do(async ($) => {
		const query = $(parseSchema(querySchema, request.query));
		const viewer = $(await requireViewer(request));
		$(requireAskExperiment(viewer));
		const sources = $(await findSources(viewer, query.collection, 'list')).filter((source) => source.collection.searchHint !== undefined);
		const {found, failed} = await eachSource(sources, (source) => searchSource(source, query.words));
		const records = found.flatMap(({value}) => value).slice(0, LIMIT);
		return {sources: sources.map(summarize), records, failed};
	});
}
