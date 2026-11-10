import {Err, type Result} from 'ts-results-es';

import {ApiErr, type ApiError, Do, requirePresent} from '@proxy/utils';

import {GITHUB_API, installGitHubAppHint, requireGitHubClient} from '../connections/github/github-app';
import {callGitHub, githubRequest} from '../connections/github/github-client';
import {fetchInstallationRepositories, fetchInstallations, PAGE_SIZE, type Repository, repositorySchema} from '../connections/github/installations';
import type {DataRecord, ListQuery, RecordPage, RecordStore, RecordTarget} from './connector';

/**
 * The repositories a GitHub connection reaches, read live from GitHub as the person who signed
 * in: those the app is installed on, on their own account and in the organizations they are in,
 * that they can see, one installation after another, a hundred to a page. A repository is
 * "owner/name", which is its id here, and opens by it. GitHub lists an installation's
 * repositories in no order it promises, and has no search over them, so the list takes no search.
 */

function toRecord(repository: Repository): DataRecord {
	const updatedAt = repository.pushed_at ?? repository.updated_at ?? new Date(0).toISOString();
	return {
		id: repository.full_name,
		values: {
			fullName: repository.full_name,
			description: repository.description ?? '',
			visibility: repository.private ? 'Private' : 'Public',
			defaultBranch: repository.default_branch ?? '',
			language: repository.language ?? '',
			pushed: repository.pushed_at ?? '',
		},
		updatedAt,
		url: repository.html_url,
	};
}

// Where a list is: which of the person's installations, by its id, and which page of it.
type Cursor = {installationId: number; page: number};

function parseCursor(page: string | null): Result<Cursor | null, ApiError> {
	if (page === null) {
		return Do(() => null);
	}
	const match = /^(\d+):(\d+)$/.exec(page);
	if (!match) {
		return Err(ApiErr.validationError('That page is not one this list gave'));
	}
	return Do(() => ({installationId: Number(match[1]), page: Number(match[2])}));
}

function cursorText(cursor: Cursor): string {
	return `${cursor.installationId}:${cursor.page}`;
}

// A repository's id as GitHub's path, or none for one that isn't "owner/name".
function repositoryPath(recordId: string): string | null {
	const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(recordId);
	return match ? `${encodeURIComponent(match[1] ?? '')}/${encodeURIComponent(match[2] ?? '')}` : null;
}

const CHANGED = 'That page is not one this list gave: the installations changed';

function list(target: RecordTarget, query: ListQuery): Promise<Result<RecordPage, ApiError>> {
	return Do(async ($) => {
		const cursor = $(parseCursor(query.page));
		return $(
			await callGitHub(target.connection, (accessToken) =>
				Do(async ($$) => {
					const ids = $$(await fetchInstallations(accessToken)).map((installation) => installation.id);
					if (ids.length === 0) {
						return $$(Err(ApiErr.validationError(installGitHubAppHint($$(requireGitHubClient())))));
					}
					const at = cursor === null ? 0 : ids.indexOf(cursor.installationId);
					if (at === -1) {
						return $$(Err(ApiErr.validationError(CHANGED)));
					}
					const installationId = $$(requirePresent(ids[at], ApiErr.validationError(CHANGED)));
					const page = cursor?.page ?? 1;
					const {repositories} = $$(await fetchInstallationRepositories(accessToken, installationId, page));
					const next = ids[at + 1];
					const nextPage = repositories.length === PAGE_SIZE ? cursorText({installationId, page: page + 1}) : next === undefined ? null : cursorText({installationId: next, page: 1});
					return {records: repositories.map(toRecord), nextPage};
				}),
			),
		);
	});
}

function get(target: RecordTarget, recordId: string): Promise<Result<DataRecord, ApiError>> {
	return Do(async ($) => {
		const path = repositoryPath(recordId);
		if (path === null) {
			return $(Err(ApiErr.notFound('record', recordId)));
		}
		const repository = $(
			(await callGitHub(target.connection, (accessToken) => githubRequest(accessToken, `${GITHUB_API}/repos/${path}`, repositorySchema))).mapErr((error) =>
				error.kind === 'not_found' ? ApiErr.notFound('record', recordId) : error,
			),
		);
		return toRecord(repository);
	});
}

export const repositoriesConnector = {list, get} satisfies RecordStore;
