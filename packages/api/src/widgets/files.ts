import type {Result} from 'ts-results-es';
import {z} from 'zod';

import {type ApiError, Do, parseSchema} from '@proxy/utils';
import type {IntegrationId} from '@proxy/integrations';

import type {AuthenticatedRequest} from '../server/middleware/require-auth';
import {requireUserOrgId} from '../utils/user-org';
import {driveQuoted, listFiles, type DriveFile} from '../connections/google/drive-api';
import {callGoogle} from '../connections/google/google-client';
import {kindOf} from '../records/google-files';
import {eachSource, type Failure} from './each-source';
import {findSources, summarize, type Source, type SourceSummary} from './sources';

/**
 * Files for the Find file widget: a search of every file store connected, each in its own terms,
 * by name, or where no name has the words, inside the files. The kind said ("the leichtle doc") is
 * a preference, not a filter: files of it come first, then the rest, the most recently changed
 * first, since people say "doc" of a spreadsheet, a PDF or a Word file as well.
 */

const KINDS = ['Document', 'Spreadsheet', 'Presentation', 'Folder'] as const;

type Kind = (typeof KINDS)[number];

/** A search for files as the home page asks it: words of the name, the kind preferred, an owner's address. */
export type FileSearch = {words: string[]; kind: Kind | null; owner: string | null};

/** Where a file has the words searched for: in its name, or only inside it. */
export type Matched = 'name' | 'content';

export type FoundFile = {connectionId: string; id: string; name: string; kind: string; owner: string; modified: string; link: string | null; matched: Matched};

/** How an integration's files are searched; a file integration joins the widget with one. */
type FilesSearch = (source: Source, search: FileSearch, limit: number) => Promise<Result<FoundFile[], ApiError>>;

// What the widget lists at most, across every file store.
const LIMIT = 8;

// How many files a name search reads, for those of the kind preferred to come first from among them.
const READ = 30;

/** The search in Drive's query language: every word in the name, or in the text, owned by the owner. */
export function driveQuery(search: FileSearch, matched: Matched): string {
	const field = matched === 'name' ? 'name' : 'fullText';
	return [...search.words.map((word) => `${field} contains ${driveQuoted(word)}`), ...(search.owner ? [`${driveQuoted(search.owner)} in owners`] : []), 'trashed = false'].join(' and ');
}

function foundFile(connectionId: string, file: DriveFile, matched: Matched): FoundFile {
	const owner = file.owners?.[0];
	return {
		connectionId,
		id: file.id,
		name: file.name,
		kind: kindOf(file.mimeType),
		owner: owner?.displayName ?? owner?.emailAddress ?? '',
		modified: file.modifiedTime ?? '',
		link: file.webViewLink ?? null,
		matched,
	};
}

// Drive, shared drives too: by name, the most recently changed first, else inside the files, in the
// order Drive finds best, as it sorts no full-text search.
const searchDrive: FilesSearch = (source, search, limit) =>
	callGoogle(source.connection, (token) =>
		Do(async ($) => {
			const params = {corpora: 'allDrives'};
			const byName = $(await listFiles(token, driveQuery(search, 'name'), {...params, orderBy: 'modifiedTime desc', pageSize: String(READ)}, null));
			if (byName.items.length > 0 || search.words.length === 0) {
				return byName.items.map((file) => foundFile(source.connection.id, file, 'name'));
			}
			const inside = $(await listFiles(token, driveQuery(search, 'content'), {...params, pageSize: String(limit)}, null));
			return inside.items.map((file) => foundFile(source.connection.id, file, 'content'));
		}),
	);

/** The files to show: of the kind preferred first, then those named with the words, then the most recently changed. */
export function rankFiles(files: FoundFile[], kind: Kind | null): FoundFile[] {
	const score = (file: FoundFile) => (file.kind === kind ? 2 : 0) + (file.matched === 'name' ? 1 : 0);
	return [...files].sort((a, b) => score(b) - score(a) || Date.parse(b.modified || '0') - Date.parse(a.modified || '0')).slice(0, LIMIT);
}

const SEARCHES: Partial<Record<IntegrationId, FilesSearch>> = {google: searchDrive};

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
			kind: query.kind ?? null,
			owner: query.owner ?? null,
		};
		const orgId = $(await requireUserOrgId(request));
		const sources = $(await findSources(orgId, 'files', 'list')).flatMap((source) => {
			const find = SEARCHES[source.integration.id];
			return find ? [{...source, find}] : [];
		});
		const {found, failed} = await eachSource(sources, (source) => source.find(source, search, LIMIT));
		const files = rankFiles(
			found.flatMap(({value}) => value),
			search.kind,
		);
		return {sources: sources.map(summarize), files, failed};
	});
}
