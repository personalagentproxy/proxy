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

function sameDay(a: Date, b: Date): boolean {
	return (
		a.getFullYear() === b.getFullYear() &&
		a.getMonth() === b.getMonth() &&
		a.getDate() === b.getDate()
	);
}

/**
 * When something was said in a chat, as a chat app says it: "3:00 AM" today, "Yesterday 3:00 AM",
 * "Sat, Sep 26 3:00 AM", with the year once it is not this year's; days as `now` counts them.
 */
export function formatMessageTime(iso: string, now = new Date()): string {
	const date = new Date(iso);
	const hour = HOUR_FORMAT.format(date);
	if (sameDay(date, now)) {
		return hour;
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
