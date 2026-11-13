import {Err, Ok, type Result} from 'ts-results-es';

import {ApiErr, type ApiError, Do, requirePresent} from '@proxy/utils';
import {CHAT_STANDINGS} from '@proxy/integrations';
import {deleteAlert, listMemberAlerts, type MemberAlertRow} from '@proxy/db/alerts';
import {getOrgSlug, getThreadPlace, listMemberThreads, type MemberThreadRow, type ThreadStandingFilter} from '@proxy/db/chat';
import {getMemberThread} from '@proxy/db/harness';

import {alertComes} from '../../harness/alerts';
import {SHOWN_CALLS} from '../../harness/thread-rules';
import {threadLines} from '../../harness/thread-standing';
import {requireAppUrl} from '../../oauth/oauth-config';
import {requireFirstPage, type DataRecord, type ListQuery, type RecordStore, type RecordTarget} from '../../records/connector';

/**
 * Chat's collections: a member's own threads with their agents, whichever persona each is with,
 * and the alerts set in them, read as the Chat page and the Alerts page read them. The member is
 * the connection's, so the records are theirs whoever reads them through it. A thread in a list
 * is its row: its title, whom it is with, where it stands and, while current, the sentence that
 * says so; opened, it carries what was said in it too, as the member sees it. Its url is its page
 * in Chat, which is where the person goes on with it: nothing here writes to a thread.
 */

// How many threads a page of the list holds.
const PAGE_SIZE = 50;

// The member whose Chat the connection is.
function memberOf(target: RecordTarget): {orgId: string; userId: string} {
	return {orgId: target.connection.orgId, userId: target.connection.ownerUserId};
}

// A thread's page in Chat.
function threadUrl(appUrl: string, orgSlug: string, personaId: string, threadId: string): string {
	return `${appUrl}/${orgSlug}/chat/${personaId}/threads/${threadId}`;
}

// The standings a list is narrowed to, each by the word the catalog offers for it.
const STANDING_FILTERS: Array<{standing: ThreadStandingFilter; label: string}> = [
	{standing: 'in_progress', label: CHAT_STANDINGS.in_progress},
	{standing: 'waiting', label: CHAT_STANDINGS.waiting},
	{standing: 'done', label: CHAT_STANDINGS.done},
];

// The standing a list is narrowed to, by its word; null for none.
function standingFilter(filter: string | null): Result<ThreadStandingFilter | null, ApiError> {
	if (filter === null) {
		return Ok(null);
	}
	const found = STANDING_FILTERS.find(({label}) => label === filter);
	if (!found) {
		return Err(ApiErr.validationError(`Standing is one of ${STANDING_FILTERS.map(({label}) => label).join(', ')}`));
	}
	return Ok(found.standing);
}

// Where a list goes on from: the page a list before it pointed at, a count of threads.
function pageStart(page: string | null): Result<number, ApiError> {
	if (page === null) {
		return Ok(0);
	}
	const start = Number(page);
	if (!Number.isInteger(start) || start <= 0) {
		return Err(ApiErr.validationError('That page is not one a list gave'));
	}
	return Ok(start);
}

// Where the thread stands, in the Chat page's words: in progress while at work or asleep; once
// stopped, waiting for the person where its turn's end said so, or done.
function standing(thread: Pick<MemberThreadRow, 'state' | 'standing'>): string {
	if (thread.state.kind !== 'stopped') {
		return CHAT_STANDINGS.in_progress;
	}
	return thread.standing.waitingForMember ? CHAT_STANDINGS.waiting : CHAT_STANDINGS.done;
}

// The thread's summary while it is current, written from everything said in it; nothing otherwise.
function summary({standing: {summary: sentence, summarySeq}, last}: Pick<MemberThreadRow, 'standing' | 'last'>): string {
	if (sentence === null || summarySeq === null || (last !== null && (last.pending || last.seq > summarySeq))) {
		return '';
	}
	return sentence;
}

function threadRecord(thread: MemberThreadRow, messages: string, url: string): DataRecord {
	const lastAt = (thread.last?.createdAt ?? thread.createdAt).toISOString();
	return {
		id: thread.id,
		values: {title: thread.title ?? '', agent: thread.personaName, standing: standing(thread), summary: summary(thread), lastMessageAt: lastAt, messages},
		updatedAt: lastAt,
		url,
	};
}

export const threadsConnector = {
	list: (target, query: ListQuery) =>
		Do(async ($) => {
			const appUrl = $(requireAppUrl());
			const start = $(pageStart(query.page));
			const listed = $(
				await listMemberThreads(memberOf(target).orgId, memberOf(target).userId, {
					search: query.search,
					standing: $(standingFilter(query.filter)),
					skip: start,
					take: PAGE_SIZE + 1,
				}),
			);
			const threads = listed?.threads ?? [];
			return {
				// What was said in each is read by opening it.
				records: threads.slice(0, PAGE_SIZE).map((thread) => threadRecord(thread, '', threadUrl(appUrl, listed?.orgSlug ?? '', thread.personaId, thread.id))),
				nextPage: threads.length > PAGE_SIZE ? String(start + PAGE_SIZE) : null,
			};
		}),
	get: (target, recordId) =>
		Do(async ($) => {
			const appUrl = $(requireAppUrl());
			const missing = ApiErr.notFound('record', recordId);
			const thread = $(requirePresent($(await getMemberThread(memberOf(target), recordId, SHOWN_CALLS)), missing));
			const place = $(requirePresent($(await getThreadPlace(thread.orgId, thread.personaId)), missing));
			const row: MemberThreadRow = {...thread, personaName: place.personaName, last: thread.entries.at(-1) ?? null};
			return threadRecord(row, threadLines(thread, Number.POSITIVE_INFINITY).join('\n\n'), threadUrl(appUrl, place.orgSlug, thread.personaId, thread.id));
		}),
} satisfies RecordStore;

function alertRecord(alert: MemberAlertRow, url: string): DataRecord {
	return {
		id: alert.id,
		values: {title: alert.title, comes: alertComes(alert), note: alert.brief, thread: alert.threadTitle ?? '', agent: alert.persona.name},
		updatedAt: alert.createdAt.toISOString(),
		url,
	};
}

// The member's alerts as records, each with its thread's page, where it comes.
function alertRecords(target: RecordTarget): Promise<Result<DataRecord[], ApiError>> {
	return Do(async ($) => {
		const appUrl = $(requireAppUrl());
		const {orgId, userId} = memberOf(target);
		const alerts = $(await listMemberAlerts(orgId, userId));
		const orgSlug = alerts.length === 0 ? '' : ($(await getOrgSlug(orgId)) ?? '');
		return alerts.map((alert) => alertRecord(alert, threadUrl(appUrl, orgSlug, alert.persona.id, alert.threadId)));
	});
}

export const alertsConnector = {
	// Few enough to list on one page.
	list: (target, query: ListQuery) =>
		Do(async ($) => {
			$(requireFirstPage(query));
			return {records: $(await alertRecords(target)), nextPage: null};
		}),
	get: (target, recordId) =>
		Do(async ($) => {
			const found = $(await alertRecords(target)).find((record) => record.id === recordId);
			return $(requirePresent(found, ApiErr.notFound('record', recordId)));
		}),
	remove: (target, recordId) =>
		Do(async ($) => {
			if (!$(await deleteAlert(recordId, memberOf(target)))) {
				return $(Err(ApiErr.notFound('record', recordId)));
			}
		}),
} satisfies RecordStore;
