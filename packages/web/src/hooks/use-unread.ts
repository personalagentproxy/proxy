import {createContext, useContext} from 'react';

/**
 * What the agents said that the person hasn't seen, across the organization's conversations, as
 * the provider around the human side keeps it (components/unread-provider.tsx).
 */
export type Unread = {
	// Whether the conversations have been asked about since the page opened.
	loaded: boolean;
	// The personas with something unread, the one open in view left out.
	unreadIds: ReadonlySet<string>;
	// How many conversations have something unread.
	count: number;
	// Which conversation the Chat page shows while it is in view, which counts as read; null
	// elsewhere, and while the page is out of view.
	setOpen: (personaId: string | null) => void;
	// The person has seen the conversation: unread no longer, at once, ahead of the next poll.
	markSeen: (personaId: string) => void;
};

const NOTHING: Unread = {
	loaded: false,
	unreadIds: new Set(),
	count: 0,
	setOpen: () => undefined,
	markSeen: () => undefined,
};

export const UnreadContext = createContext<Unread>(NOTHING);

/** What is unread across the conversations; nothing outside the provider. */
export function useUnread(): Unread {
	return useContext(UnreadContext);
}
