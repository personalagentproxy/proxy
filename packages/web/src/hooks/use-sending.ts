import {useMemo, useState} from 'react';
import {type Sending, settleSending} from '@/lib/chat-log';

// What the person sends in a chat, shown at the end of it at once, before the server has it, and
// kept there, under the key it was shown with, as the chat read again brings the server's copy:
// so it is drawn once, as it is sent, and not again as it lands. `personText`, what the person said
// in an entry, null for one that isn't theirs, must not change. What was sent is kept while the
// chat is open, a few entries at most, so the server's copy keeps the key it was shown with.

export type SendingChat<E> = {
	// The chat's entries, with what was sent and isn't in them yet after them.
	entries: E[];
	// Whether something sent isn't in the chat yet.
	waiting: boolean;
	// The key an entry is drawn under: the one it was shown with as it was sent, or its id.
	keyOf: (entry: E) => string;
	// Whether the person sent an entry from this page, as against it coming from elsewhere.
	sentHere: (entry: E) => boolean;
	// The id the server knows an entry by: its own, or, for one shown as sent that the chat doesn't
	// have yet, the one its send answered with, null until it has.
	idOf: (entry: E) => string | null;
	// Shows `entry`, under its id, as sent.
	start: (entry: E) => void;
	// The send of what was shown under `key` was taken, as the server's entry `id` where it says.
	posted: (key: string, id: string | null) => void;
	// The send of what was shown under `key` failed: it is taken away.
	failed: (key: string) => void;
};

export function useSending<E extends {id: string}>(
	entries: E[],
	personText: (entry: E) => string | null,
): SendingChat<E> {
	const [sending, setSending] = useState<Sending<E>[]>([]);
	const {waiting, arrived} = useMemo(
		() => settleSending(sending, entries, personText),
		[sending, entries, personText],
	);
	const shown = useMemo(
		() => (waiting.length === 0 ? entries : [...entries, ...waiting.map((sent) => sent.entry)]),
		[entries, waiting],
	);

	const keyOf = (entry: E) => arrived.get(entry.id) ?? entry.id;
	return {
		entries: shown,
		waiting: waiting.length > 0,
		keyOf,
		sentHere: (entry) => sending.some((sent) => sent.key === keyOf(entry)),
		idOf: (entry) => {
			const sent = waiting.find((one) => one.entry.id === entry.id);
			return sent === undefined ? entry.id : sent.id;
		},
		start: (entry) => {
			const before = new Set(entries.map((candidate) => candidate.id));
			setSending((current) => [...current, {key: entry.id, entry, id: null, before}]);
		},
		posted: (key, id) => {
			setSending((current) => current.map((sent) => (sent.key === key ? {...sent, id} : sent)));
		},
		failed: (key) => {
			setSending((current) => current.filter((sent) => sent.key !== key));
		},
	};
}
