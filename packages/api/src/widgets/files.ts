import type {Result} from 'ts-results-es';
import {z} from 'zod';

import {type ApiError, Do, parseSchema} from '@proxy/utils';

import type {AuthenticatedRequest} from '../server/middleware/require-auth';
import {requireViewer} from '../utils/user-org';
import type {FileSearch, MatchedFile} from '../records/capabilities';
import {eachSource, type Failure} from './each-source';
import {findSources, summarize, withCapability, type SourceSummary} from './sources';

/**
 * Files for the Find file widget: a search of every file store connected, each in its own terms,
 * by name, or where no name has the words, inside the files. The kind said ("the leichtle doc") is
 * a preference, not a filter: files of it come first, then the rest, the most recently changed
 * first, since people say "doc" of a spreadsheet, a PDF or a Word file as well.
 */

const KINDS = ['Document', 'Spreadsheet', 'Presentation', 'Folder'] as const;

type Kind = (typeof KINDS)[number];

export type FoundFile = {connectionId: string} & MatchedFile;

// What the widget lists at most, across every file store.
const LIMIT = 8;

/** The files to show: of the kind preferred first, then those named with the words, then the most recently changed. */
export function rankFiles(files: FoundFile[], kind: Kind | null): FoundFile[] {
	const score = (file: FoundFile) => (file.kind === kind ? 2 : 0) + (file.matched === 'name' ? 1 : 0);
	return [...files].sort((a, b) => score(b) - score(a) || Date.parse(b.modified || '0') - Date.parse(a.modified || '0')).slice(0, LIMIT);
}

const querySchema = z.object({
	words: z.union([z.string(), z.array(z.string())]).optional(),
	kind: z.enum(KINDS).optional(),
	owner: z.email().optional(),
});

export type FoundFiles = {sources: SourceSummary[]; files: FoundFile[]; failed: Failure[]};

/** `GET /api/widgets/files?words=…&kind=…&owner=…`: the files each file store finds. */
export function handleFindFilesRoute(request: AuthenticatedRequest): Promise<Result<FoundFiles, ApiError>> {
	return Do(async ($) => {
		const query = $(parseSchema(querySchema, request.query));
		const words = query.words === undefined ? [] : Array.isArray(query.words) ? query.words : [query.words];
		const search: FileSearch = {
			words: words
				.map((word) => word.trim().slice(0, 100))
				.filter((word) => word !== '')
				.slice(0, 10),
			owner: query.owner ?? null,
		};
		const viewer = $(await requireViewer(request));
		const sources = withCapability($(await findSources(viewer, 'files', 'list')), 'findFiles');
		const {found, failed} = await eachSource(sources, (source) => source.connector.findFiles(source, search, LIMIT));
		const files = rankFiles(
			found.flatMap(({source, value}) => value.map((file): FoundFile => ({connectionId: source.connection.id, ...file}))),
			query.kind ?? null,
		);
		return {sources: sources.map(summarize), files, failed};
	});
}
