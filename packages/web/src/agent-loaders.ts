import type {FetchError} from '@proxy/utils';
import {redirect} from 'react-router';
import type {Result} from 'ts-results-es';
import {getAgentMe, getAgentRecord, listAgentRecords} from '@/client/agent-client';
import {isNotFoundError, isUnauthenticatedError} from '@/client/me-client';
import {fetchErrorToResponse} from '@/lib/loader-utils';

// The agent side's pages. Every records request is checked and logged by the api; a page shows
// what came back, a refusal included.

// No live session, a revoked login included, sends the agent to its sign-in.
function unwrapAgentResult<T>(result: Result<T, FetchError>): T {
	if (result.isOk()) {
		return result.value;
	}
	if (isUnauthenticatedError(result.error)) {
		throw redirect('/agent/login');
	}
	throw fetchErrorToResponse(result.error);
}

export type Outcome<T> = {kind: 'ok'; value: T} | {kind: 'denied'} | {kind: 'missing'};

function toOutcome<T>(result: Result<T, FetchError>): Outcome<T> {
	if (result.isErr() && result.error.kind === 'http' && result.error.status === 403) {
		return {kind: 'denied'};
	}
	if (result.isErr() && isNotFoundError(result.error)) {
		return {kind: 'missing'};
	}
	return {kind: 'ok', value: unwrapAgentResult(result)};
}

export async function agentSideLoader() {
	return unwrapAgentResult(await getAgentMe());
}

type Params = {connectionId?: string; collectionId?: string; recordId?: string};

// `?search=` and `?page=` in the address go to the api as they are.
export async function agentCollectionLoader({params, request}: {params: Params; request: Request}) {
	const url = new URL(request.url).searchParams;
	const query = {search: url.get('search'), page: url.get('page')};
	return toOutcome(
		await listAgentRecords(params.connectionId ?? '', params.collectionId ?? '', query),
	);
}

export async function agentRecordLoader({params}: {params: Params}) {
	return toOutcome(
		await getAgentRecord(
			params.connectionId ?? '',
			params.collectionId ?? '',
			params.recordId ?? '',
		),
	);
}
