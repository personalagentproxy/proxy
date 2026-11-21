import {Err, Ok, type Result} from 'ts-results-es';

import {ApiErr, type ApiError, Do, requirePresent} from '@proxy/utils';
import {CHAT_PLACES, CHAT_STANDINGS} from '@proxy/integrations';
import {deleteAlert, listMemberAlerts, type MemberAlertRow} from '@proxy/db/alerts';
import {getOrgSlug, getThreadAddress, listMemberThreads, type MemberThreadRow, type ThreadStandingFilter} from '@proxy/db/chat';
import {changeMemberThreadStanding, getMemberThread, type SlackThreadRow, type StandingChange} from '@proxy/db/harness';

import {alertComes} from '../../harness/alerts';
import {SHOWN_CALLS} from '../../harness/thread-rules';
import {standingOf, threadLines} from '../../harness/thread-standing';
import {requireAppUrl} from '../../oauth/oauth-config';
import {slackThreadUrl} from '../../slack/thread-link';
import {type CommandRunner, requireFirstPage, type DataRecord, type ListQuery, type RecordStore, type RecordTarget} from '../../records/connector';

/**
 * Chat's collections: a member's own threads with their agents, whichever persona each is with,
 * and the alerts set in them, read as the Chat page and the Alerts page read them. The member is
 * the connection's, so the records are theirs whoever reads them through it. A thread in a list
 * is its row: its title, whom it is with, where it lives, where it stands and, while current, the
 * sentence that says so; opened, it carries what was said in it too, as the member sees it. Its
 * url is where it lives, its page in Chat or its thread in Slack, which is where the person goes on
 * with it. Where it stands is changed by its commands, as the member changes it on the Chat page,
 * on any of their threads wherever it lives; for one in Slack its session's status there follows,
 * as the delivery sweep keeps it (slack/sessions.ts).
 */

// How many threads a page of the list holds.
const PAGE_SIZE = 50;

// The member whose Chat the connection is.
function memberOf(target: RecordTarget): {orgId: string; userId: string} {
	return {orgId: target.connection.orgId, userId: target.connection.ownerUserId};
}

// Where a thread lives, as the person goes on with it: its thread in Slack, for one that lives
// there, which the app doesn't show; its page in Chat otherwise.
function threadUrl(appUrl: string, orgSlug: string, thread: {id: string; personaId: string; slack: SlackThreadRow | null}): string {
	if (thread.slack !== null) {
		return slackThreadUrl(thread.slack);
	}
	return `${appUrl}/${orgSlug}/chat/${thread.personaId}/threads/${thread.id}`;
}

// The standings a list is narrowed to, each by the word the catalog offers for it.
const STANDING_FILTERS: Array<{standing: ThreadStandingFilter; label: string}> = [
	{standing: 'in_progress', label: CHAT_STANDINGS.in_progress},
	{standing: 'waiting', label: CHAT_STANDINGS.waiting},
	{standing: 'watching', label: CHAT_STANDINGS.watching},
	{standing: 'done', label: CHAT_STANDINGS.done},
	{standing: 'archived', label: CHAT_STANDINGS.archived},
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

// Where the thread stands, in the Chat page's words, as standingOf says; once stopped, archived
// where the person archived it.
function standing(thread: Pick<MemberThreadRow, 'state' | 'standing' | 'alerts'>): string {
	if (thread.state.kind === 'stopped' && thread.standing.archived) {
		return CHAT_STANDINGS.archived;
	}
	return CHAT_STANDINGS[standingOf(thread)];
}

// The thread's summary while it is current, written from everything said in it; nothing otherwise.
function summary({standing: {summary: sentence, summarySeq}, last}: Pick<MemberThreadRow, 'standing' | 'last'>): string {
	if (sentence === null || summarySeq === null || (last !== null && (last.pending || last.seq > summarySeq))) {
		return '';
	}
	return sentence;
}

// Where the thread lives, as its record says it.
function place(thread: Pick<MemberThreadRow, 'slack'>): string {
	return thread.slack === null ? CHAT_PLACES.chat : CHAT_PLACES.slack;
}

/**
 * The thread in a line, in its record's words, as a thread's agent is told of the person's other
 * threads (harness/inference.ts): its id, title, whom it is with, where it lives, where it stands
 * and, while current, its summary.
 */
export function threadLine(thread: MemberThreadRow): string {
	const said = summary(thread);
	return `${thread.id}: “${thread.title ?? ''}” with ${thread.personaName}, in ${place(thread)}, ${standing(thread)}${said === '' ? '' : `: ${said}`}`;
}

function threadRecord(thread: MemberThreadRow, messages: string, url: string): DataRecord {
	const lastAt = (thread.last?.createdAt ?? thread.createdAt).toISOString();
	return {
		id: thread.id,
		values: {
			title: thread.title ?? '',
			agent: thread.personaName,
			place: place(thread),
			standing: standing(thread),
			summary: summary(thread),
			lastMessageAt: lastAt,
			messages,
		},
		updatedAt: lastAt,
		url,
	};
}

function getThread(target: RecordTarget, recordId: string): Promise<Result<DataRecord, ApiError>> {
	return Do(async ($) => {
		const appUrl = $(requireAppUrl());
		const missing = ApiErr.notFound('record', recordId);
		const thread = $(requirePresent($(await getMemberThread(memberOf(target), recordId, SHOWN_CALLS)), missing));
		const address = $(requirePresent($(await getThreadAddress(thread)), missing));
		const row: MemberThreadRow = {...thread, personaName: address.personaName, slack: address.slack, last: thread.entries.at(-1) ?? null};
		return threadRecord(row, threadLines(thread, Number.POSITIVE_INFINITY).join('\n\n'), threadUrl(appUrl, address.orgSlug, row));
	});
}

// Changes where the thread stands, and answers with it as it is then. One in progress, or watching
// for one to archive, is refused here too, though the catalog's condition refused it as it was
// read, since it may have been taken up since.
function standingCommand(change: StandingChange): CommandRunner {
	return (target, recordId) =>
		Do(async ($) => {
			const changed = $(await changeMemberThreadStanding(memberOf(target), recordId, change));
			if (changed === null) {
				return $(Err(ApiErr.notFound('record', recordId)));
			}
			if (changed === 'in_progress') {
				return $(Err(ApiErr.validationError(`That thread is ${CHAT_STANDINGS.in_progress.toLowerCase()}, or its sub-agents are at work: where it stands is written as its turn ends`)));
			}
			if (changed === 'watching') {
				return $(Err(ApiErr.validationError(`That thread is ${CHAT_STANDINGS.watching}: archiving it would cancel the alerts that come to it, so ask the person, and cancel them first`)));
			}
			return $(await getThread(target, recordId));
		});
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
				records: threads.slice(0, PAGE_SIZE).map((thread) => threadRecord(thread, '', threadUrl(appUrl, listed?.orgSlug ?? '', thread))),
				nextPage: threads.length > PAGE_SIZE ? String(start + PAGE_SIZE) : null,
			};
		}),
	get: getThread,
	commands: {markDone: standingCommand('done'), archive: standingCommand('archive'), unarchive: standingCommand('unarchive')},
} satisfies RecordStore;

function alertRecord(alert: MemberAlertRow, url: string): DataRecord {
	return {
		id: alert.id,
		values: {title: alert.title, comes: alertComes(alert), note: alert.brief, thread: alert.thread?.title ?? 'A new thread each time', agent: alert.persona.name},
		updatedAt: alert.createdAt.toISOString(),
		url,
	};
}

// The member's alerts as records, each with where the thread it comes to lives, or, one that opens
// a new thread each time, the thread it was set in, or the chat's page once that is gone.
function alertRecords(target: RecordTarget): Promise<Result<DataRecord[], ApiError>> {
	return Do(async ($) => {
		const appUrl = $(requireAppUrl());
		const {orgId, userId} = memberOf(target);
		const alerts = $(await listMemberAlerts(orgId, userId));
		const orgSlug = alerts.length === 0 ? '' : ($(await getOrgSlug(orgId)) ?? '');
		return alerts.map((alert) => {
			const thread = alert.thread ?? alert.setIn;
			const url = thread === null ? `${appUrl}/${orgSlug}/chat/${alert.persona.id}` : threadUrl(appUrl, orgSlug, {...thread, personaId: alert.persona.id});
			return alertRecord(alert, url);
		});
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
