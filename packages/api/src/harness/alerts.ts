import {describeCriteria, isWatchCollection, parseCriteria, type PollItem, WATCH_COLLECTIONS} from '@proxy/utils/alerts';
import {cut} from '@proxy/utils/harness';
import type {AlertRow, MatchedItem} from '@proxy/db/harness';

/**
 * The words of alerts, which the store's transactions write by (store.ts), as the conversation's
 * are (conversation.ts): what the agent is told of the alerts it has set; what a timed alert
 * lands in the conversation when it is due; what a watch's conversation is told of the records
 * that matched it, with their links, for the agent to pass on; and what it is told when the
 * connection a watch was on is gone, so the person can have it set again.
 */

// How much of a record's fields a match keeps.
const MAX_SUMMARY = 300;

const SET_AGAIN = 'Tell the person; set it again if they want it kept.';

function time(date: Date | null): string {
	return date?.toISOString() ?? '';
}

function collectionName(collectionId: string | null): string {
	return collectionId !== null && isWatchCollection(collectionId) ? WATCH_COLLECTIONS[collectionId].name : (collectionId ?? '');
}

/** An alert in a line, as the agent is told of it and answered when it sets one: its id, title, and what it is. */
export function describeAlert(alert: AlertRow): string {
	if (alert.collectionId === null) {
		return `${alert.id}: “${alert.title}”, due ${time(alert.at)}`;
	}
	const where = alert.connectionIds.length === 1 ? `connection ${alert.connectionIds[0] ?? ''}` : `connections ${alert.connectionIds.join(', ')}`;
	return `${alert.id}: “${alert.title}”, watching ${collectionName(alert.collectionId)} in ${where} for ${describeCriteria(parseCriteria(alert.criteria))}`;
}

/** What the agent is told, in its instructions, of the alerts set in its conversation. */
export function alertsParagraph(alerts: AlertRow[]): string {
	if (alerts.length === 0) {
		return 'No alert is set in this conversation.';
	}
	return `The alerts set in this conversation, still going, each by the id cancel_alert takes:\n${alerts.map((alert) => `- ${describeAlert(alert)}`).join('\n')}`;
}

/** What a timed alert lands in the conversation when it is due. */
export function dueText(alert: AlertRow): string {
	return `The alert “${alert.title}” is due now, which you set for ${time(alert.at)}. What you noted for it: ${alert.brief}`;
}

/** What a match keeps of a record: its fields with something in them, in a line. */
export function itemSummary(item: PollItem): string {
	const parts = Object.entries(item.fields)
		.filter(([, value]) => value.trim() !== '')
		.map(([field, value]) => `${field}: ${value.replace(/\s+/g, ' ').trim()}`);
	return cut(parts.join(' · '), MAX_SUMMARY);
}

/** What a watch's conversation is told of the records that matched it now, with their links, for the agent to pass on. */
export function matchText(alert: AlertRow, items: MatchedItem[]): string {
	const name = collectionName(alert.collectionId);
	const lines = items.map((item) => `- ${item.title}${item.url ? ` (${item.url})` : ''} — ${item.summary}; id ${item.recordId}, at ${item.at}`);
	return [
		`The alert “${alert.title}” matched ${items.length === 1 ? `a new one of the ${name}` : `${items.length} new ${name}`} it watches, for ${describeCriteria(parseCriteria(alert.criteria))}:`,
		lines.join('\n'),
		`What you noted for it: ${alert.brief}`,
	].join('\n\n');
}

/** What a watch's conversation is told when the last connection it watched is gone. */
export function connectionGoneText(alert: AlertRow): string {
	return `The alert “${alert.title}” has ended: the connection it watched is gone. ${SET_AGAIN}`;
}
