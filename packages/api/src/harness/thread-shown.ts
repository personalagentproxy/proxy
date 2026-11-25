import {callArguments, CREATE_SUBAGENT_TOOL, personMessageArgs, SEND_TO_PERSON_TOOL, SEND_TO_SUBAGENT_TOOL, subAgentMessageArgs} from '@proxy/utils/harness';
import type {PassedOn, ShownEntryRow} from '@proxy/db/harness';

import {eventLine} from './alerts';

/**
 * What of a thread's log the member reads, entry by entry: what they said, there or in another of
 * their threads that passed it on to this one, which says which; the events that came
 * into it, each read as one line, but for what its sub-agents said, which the persona reads and
 * passes on; what the persona answered in words, then what it told them and the sub-agents it
 * started or wrote to as it went in the same step, each sub-agent as a line of its own; not the
 * calls it worked through, their results or the summaries. A sub-agent's own thread shows none of
 * what its persona sent it. The Chat page shows a thread by it (route.ts), and a thread that lives
 * in Slack is delivered there by it (slack/delivery-rules.ts), so the two say the same.
 */

/** A sub-agent of the thread, as much of it as says which of the thread's calls started it. */
export type SubAgentRef = {id: string; parentCallId: string | null};

/** The thread an entry is of, as what it shows needs it: whose sub-agent it is, if anyone's, and its own sub-agents. */
export type ShownThread<S extends SubAgentRef> = {subAgentOfId: string | null; subAgents: S[]};

// Where a part comes from: its entry, its own id, which names the call too for one from a call,
// and when its entry was written.
type PartOf = {entryId: string; id: string; at: Date};

/**
 * Something the thread shows, from one entry: what the member or the persona said, whether it is a
 * failure, whether it is the entry's own words, which the entry's files go with, or a message the
 * persona sent the member from a call of the entry's, and, for what the member said that another
 * of their threads passed on, where from; an event, with the line it is read as; or a line for a
 * sub-agent the persona started or wrote to.
 */
export type ShownPart<S extends SubAgentRef> =
	| (PartOf & {kind: 'person' | 'assistant'; text: string; isError: boolean; ownWords: boolean; passedOn: PassedOn | null})
	| (PartOf & {kind: 'event'; text: string; line: string; isError: boolean})
	| (PartOf & {kind: 'sub_agent'; subAgent: S});

/** What the entry shows, in order; nothing for what the member doesn't read. */
export function shownParts<S extends SubAgentRef>(
	thread: ShownThread<S>,
	entry: Pick<ShownEntryRow, 'id' | 'kind' | 'text' | 'toolCalls' | 'callId' | 'isError' | 'createdAt' | 'passedOn'>,
): ShownPart<S>[] {
	const of = (call: string | null): PartOf => ({entryId: entry.id, id: call === null ? entry.id : `${entry.id}:${call}`, at: entry.createdAt});
	if (entry.kind === 'event') {
		const fromSubAgent = entry.callId !== null && thread.subAgents.some((subAgent) => subAgent.parentCallId === entry.callId);
		return fromSubAgent ? [] : [{...of(null), kind: 'event', text: entry.text, line: eventLine(entry.text), isError: entry.isError}];
	}
	if (entry.kind === 'person') {
		return thread.subAgentOfId === null ? [{...of(null), kind: 'person', text: entry.text, isError: entry.isError, ownWords: true, passedOn: entry.passedOn}] : [];
	}
	if (entry.kind !== 'assistant') {
		return [];
	}
	const said: ShownPart<S>[] = entry.text === '' ? [] : [{...of(null), kind: 'assistant', text: entry.text, isError: entry.isError, ownWords: true, passedOn: null}];
	const told = (entry.toolCalls ?? []).flatMap((call): ShownPart<S>[] => {
		const started = call.name === CREATE_SUBAGENT_TOOL ? thread.subAgents.find((subAgent) => subAgent.parentCallId === call.id) : undefined;
		const messaged = call.name === SEND_TO_SUBAGENT_TOOL ? thread.subAgents.find((subAgent) => subAgent.id === subAgentMessageArgs(callArguments(call))?.subagent) : undefined;
		const subAgent = started ?? messaged;
		if (subAgent) {
			return [{...of(call.id), kind: 'sub_agent', subAgent}];
		}
		const message = call.name === SEND_TO_PERSON_TOOL ? personMessageArgs(callArguments(call)) : null;
		return message ? [{...of(call.id), kind: 'assistant', text: message.text, isError: false, ownWords: false, passedOn: null}] : [];
	});
	return [...said, ...told];
}
