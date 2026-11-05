import {createContext, useContext} from 'react';

/** The conversation the Chat page shows, and the persona's last answer in it, if any. */
export type Viewing = {personaId: string; answerId: string | null};

/**
 * What the agents said that the person hasn't seen, across the organization's conversations, as
 * the provider around the human side keeps it (components/unread-provider.tsx).
 */
export type Unread = {
	// Whether the conversations have been asked about since the page opened.
	loaded: boolean;
	// The personas with something unread, the one the person is looking at left out.
	unreadIds: ReadonlySet<string>;
	// Which conversation the Chat page shows, and up to which answer; null elsewhere. What it shows
	// while the person looks at it is read.
	setViewing: (viewing: Viewing | null) => void;
};

const NOTHING: Unread = {
	loaded: false,
	unreadIds: new Set(),
	setViewing: () => undefined,
};

export const UnreadContext = createContext<Unread>(NOTHING);

/** What is unread across the conversations; nothing outside the provider. */
export function useUnread(): Unread {
	return useContext(UnreadContext);
}
