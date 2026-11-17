import type {ChatAnswer} from '@proxy/contracts/harness';
import {createContext, useContext} from 'react';

/**
 * The conversation the Chat page shows, the thread open in it, if any, and the thread's unread
 * answer once the page shows it.
 */
export type Viewing = {personaId: string; threadId: string | null; answerId: string | null};

/**
 * What the agents said that the person hasn't seen, across the organization's conversations, as
 * the provider around the human side keeps it (components/unread-provider.tsx).
 */
export type Unread = {
	// How many threads, across the conversations, ended their turn with an answer the person
	// hasn't opened them to see.
	count: number;
	// The personas with a thread unread, at work or not.
	unreadIds: ReadonlySet<string>;
	// Each conversation's last answer and its unread threads, as the provider last asked; null
	// before it first has.
	answers: readonly ChatAnswer[] | null;
	// Which conversation the Chat page shows, and which thread's answer; null elsewhere. The thread
	// is read up to the answer it shows while the person looks at it.
	setViewing: (viewing: Viewing | null) => void;
	// Asks the api again now, as after the person replied in a thread, which reads it.
	refresh: () => void;
};

const NOTHING: Unread = {
	count: 0,
	unreadIds: new Set(),
	answers: null,
	setViewing: () => undefined,
	refresh: () => undefined,
};

export const UnreadContext = createContext<Unread>(NOTHING);

/** What is unread across the conversations; nothing outside the provider. */
export function useUnread(): Unread {
	return useContext(UnreadContext);
}
