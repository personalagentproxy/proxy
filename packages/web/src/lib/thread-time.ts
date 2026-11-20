// When things were said in a thread, marked between its messages as a chat app marks them: over the
// first, and over any that came after the thread had gone quiet for a while.

/** How long a thread is quiet before what comes next is marked with its time. */
export const QUIET_MS = 30 * 60 * 1000;

/** Whether a message is marked with its time: the thread's first, or one after a quiet spell since the message before. */
export function marksTime(before: string | undefined, at: string): boolean {
	if (before === undefined) {
		return true;
	}
	return new Date(at).getTime() - new Date(before).getTime() >= QUIET_MS;
}

// Made once: making a formatter is what costs.
const CLOCK = new Intl.DateTimeFormat('en-US', {hour: 'numeric', minute: '2-digit'});
const WEEKDAY = new Intl.DateTimeFormat('en-US', {weekday: 'long'});
const DAY = new Intl.DateTimeFormat('en-US', {weekday: 'short', month: 'short', day: 'numeric'});
const DAY_IN_YEAR = new Intl.DateTimeFormat('en-US', {
	weekday: 'short',
	month: 'short',
	day: 'numeric',
	year: 'numeric',
});

// How many days back `date` is from `now`, by the calendar here, not by the hours between them.
function daysBack(date: Date, now: Date): number {
	const start = (moment: Date) =>
		new Date(moment.getFullYear(), moment.getMonth(), moment.getDate()).getTime();
	// Rounded, since a day a clock change falls in is an hour shorter or longer.
	return Math.round((start(now) - start(date)) / (24 * 60 * 60 * 1000));
}

/**
 * When a message came, as the thread marks it: "Today 2:51 PM", "Yesterday 2:51 PM", the weekday
 * within the week, "Tuesday 2:51 PM", and the date before that, "Mon, Nov 17 at 2:51 PM", with
 * the year once it is not this year's.
 */
export function markedTime(iso: string, now: Date = new Date()): string {
	const date = new Date(iso);
	const clock = CLOCK.format(date);
	const back = daysBack(date, now);
	if (back === 0) {
		return `Today ${clock}`;
	}
	if (back === 1) {
		return `Yesterday ${clock}`;
	}
	if (back > 1 && back < 7) {
		return `${WEEKDAY.format(date)} ${clock}`;
	}
	const day = date.getFullYear() === now.getFullYear() ? DAY : DAY_IN_YEAR;
	return `${day.format(date)} at ${clock}`;
}
