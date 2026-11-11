import type {ChatEntry} from '@proxy/contracts/harness';

// A pause this long between two turns starts a new stretch of the conversation under its time.
const SECTION_GAP_MS = 60 * 60_000;

const DAY_FORMAT = new Intl.DateTimeFormat('en-US', {
	weekday: 'short',
	month: 'short',
	day: 'numeric',
});
const DAY_WITH_YEAR_FORMAT = new Intl.DateTimeFormat('en-US', {
	weekday: 'short',
	month: 'short',
	day: 'numeric',
	year: 'numeric',
});
const HOUR_FORMAT = new Intl.DateTimeFormat('en-US', {hour: 'numeric', minute: '2-digit'});

// Turns in a row from the same side, under the time their stretch of the conversation began
// where they are its first.
export type ChatRun<T> = {heading: string | null; entries: T[]};

// Something said, as much of it as laying the conversation out needs: when.
type Said = {at: string};

/** Which side of the conversation something is on: the person's, or the persona's, whose answers, tasks and messages to them are. */
export function conversationSide(entry: ChatEntry): 'person' | 'persona' {
	return entry.kind === 'person' ? 'person' : 'persona';
}

function sameDay(a: Date, b: Date): boolean {
	return (
		a.getFullYear() === b.getFullYear() &&
		a.getMonth() === b.getMonth() &&
		a.getDate() === b.getDate()
	);
}

// "Today 3:00 AM", "Yesterday 3:00 AM", "Sat, Sep 26 3:00 AM", with the year once it is not
// this year's: when a stretch of the conversation began, as a chat app heads it.
export function formatSectionTime(iso: string, now: Date): string {
	const date = new Date(iso);
	const hour = HOUR_FORMAT.format(date);
	if (sameDay(date, now)) {
		return `Today ${hour}`;
	}

	const yesterday = new Date(now);
	yesterday.setDate(now.getDate() - 1);
	if (sameDay(date, yesterday)) {
		return `Yesterday ${hour}`;
	}

	if (date.getFullYear() === now.getFullYear()) {
		return `${DAY_FORMAT.format(date)} ${hour}`;
	}

	return `${DAY_WITH_YEAR_FORMAT.format(date)} ${hour}`;
}

// Whether a turn starts a stretch of the conversation: the first, one after an hour's pause, or
// the first on another day.
function startsSection(entry: Said, before: Said | undefined): boolean {
	if (!before) {
		return true;
	}

	const at = new Date(entry.at);
	const previous = new Date(before.at);
	if (at.getTime() - previous.getTime() >= SECTION_GAP_MS) {
		return true;
	}

	return !sameDay(at, previous);
}

// The conversation as the page lays it out: turns in a row from the same side (`sideOf`)
// together, and a time over each stretch of it, so a conversation picked up the next day reads as
// one.
export function chatRuns<T extends Said>(
	entries: T[],
	now: Date,
	sideOf: (entry: T) => string,
): ChatRun<T>[] {
	const runs: ChatRun<T>[] = [];
	entries.forEach((entry, index) => {
		const last = runs.at(-1);
		if (startsSection(entry, entries[index - 1])) {
			runs.push({heading: formatSectionTime(entry.at, now), entries: [entry]});
			return;
		}

		const first = last?.entries[0];
		if (last && first && sideOf(first) === sideOf(entry)) {
			last.entries.push(entry);
			return;
		}

		runs.push({heading: null, entries: [entry]});
	});
	return runs;
}
