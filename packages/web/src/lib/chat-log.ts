// A chat as it is read again every so often, and what the person sent to it before the server had
// it. Drawing a turn again is costly (its Markdown is parsed again), so what didn't change in a
// read is kept as it was, and a turn sent from the page keeps its place, and its key, as the
// server's own copy of it comes.

/** Whether two things read from the api are the same: the same JSON, as the api's schema orders it. */
export function sameJson<T>(a: T, b: T): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * The entries as read again, each one that didn't change the very one there was, so a row drawn
 * from it is not drawn again; the very list there was where nothing in it changed.
 */
export function keepEntries<E extends {id: string}>(before: E[], after: E[]): E[] {
	const was = new Map(before.map((entry) => [entry.id, entry]));
	const kept = after.map((entry) => {
		const old = was.get(entry.id);
		return old !== undefined && sameJson(old, entry) ? old : entry;
	});
	if (kept.length === before.length && kept.every((entry, index) => entry === before[index])) {
		return before;
	}
	return kept;
}

/**
 * Something the person sent, shown at once: `entry` under its own `key` until the server has it,
 * by its id (`id`) once the send answered with one, and otherwise by its text among the person's
 * entries the chat didn't have as it was sent (`before`).
 */
export type Sending<E> = {key: string; entry: E; id: string | null; before: ReadonlySet<string>};

/**
 * Which of what was sent the chat has now (`personText` being what the person said in an entry,
 * null for one that isn't theirs), as the key each of its entries keeps (the server's id
 * to the key it was shown under), and which it doesn't have yet, still to be shown after it. Two
 * of the same text, sent one after the other, are taken for the first and the second such entry.
 */
export function settleSending<E extends {id: string}>(
	sending: Sending<E>[],
	entries: E[],
	personText: (entry: E) => string | null,
): {waiting: Sending<E>[]; arrived: Map<string, string>} {
	const arrived = new Map<string, string>();
	const waiting = sending.filter((sent) => {
		const found = entries.find((entry) => {
			if (arrived.has(entry.id)) {
				return false;
			}
			if (sent.id !== null) {
				return entry.id === sent.id;
			}
			const text = personText(entry);
			return text !== null && text === personText(sent.entry) && !sent.before.has(entry.id);
		});
		if (found === undefined) {
			return true;
		}
		arrived.set(found.id, sent.key);
		return false;
	});
	return {waiting, arrived};
}
