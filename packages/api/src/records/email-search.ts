/**
 * A search for email as the home page asks it, whatever the mailbox: from someone, or involving
 * them (from, to or copied), about some words, since a day. Each mailbox's connector puts it in its own terms: Gmail's search syntax,
 * over its API or over IMAP, or IMAP's own search elsewhere.
 */
export type EmailSearch = {
	// A name or an address, as the sender is written.
	from: string | null;
	// A name or an address of someone the email is from, to or copied to: the people a name stands
	// for, among those written to and heard from.
	involving?: string;
	// Terms every one of which is to be found, each a list of words any of which will do.
	words: string[][];
	// A day, 2026-10-07: email from then on.
	since: string | null;
};

function quoted(text: string): string {
	return /\s/.test(text) ? `"${text.replace(/"/g, '')}"` : text;
}

/** The search in Gmail's own syntax, as typed in its search box: `from:"Sam Lee" (invoice OR bill) after:2026/10/07`. */
export function gmailQuery(search: EmailSearch): string {
	const involving = search.involving ? quoted(search.involving) : null;
	return [
		...(search.from ? [`from:${quoted(search.from)}`] : []),
		...(involving ? [`{from:${involving} to:${involving} cc:${involving}}`] : []),
		...search.words.flatMap((term) => (term.length > 1 ? [`(${term.map(quoted).join(' OR ')})`] : term.map(quoted))),
		...(search.since ? [`after:${search.since.replace(/-/g, '/')}`] : []),
	].join(' ');
}
