import type {AgendaEvent} from '@/client/widgets-client';

// A calendar's day as the New event and Calendar widgets show it (`DayGrid`).

/** An event as a day shows it: when it is that day, and whether it is the one the widget is about. */
export type DayItem = {
	key: string;
	title: string;
	start: Date;
	end: Date;
	highlighted: boolean;
	link: string | null;
};

/** The midnight a day starts at and the next, on the person's clock. */
export function dayBounds(date: Date): {start: Date; end: Date} {
	const start = new Date(date);
	start.setHours(0, 0, 0, 0);
	const end = new Date(start);
	end.setDate(end.getDate() + 1);
	return {start, end};
}

/** The day a time falls on, as the agenda is asked for it. */
export function dayAround(date: Date): {from: string; to: string} {
	const {start, end} = dayBounds(date);
	return {from: start.toISOString(), to: end.toISOString()};
}

export function eventKey(event: Pick<AgendaEvent, 'connectionId' | 'id'>): string {
	return `${event.connectionId} ${event.id}`;
}

/** The day's events with a time, each cut to the day where it runs past midnight. */
export function timedItems(
	events: AgendaEvent[],
	day: Date,
	highlighted: string | null,
): DayItem[] {
	const {start: dayStart, end: dayEnd} = dayBounds(day);
	return events.flatMap((event) => {
		if (event.allDay) {
			return [];
		}
		const start = new Date(Math.max(Date.parse(event.start), dayStart.getTime()));
		const end = new Date(Math.min(Date.parse(event.end), dayEnd.getTime() - 60_000));
		if (end <= start) {
			return [];
		}
		const key = eventKey(event);
		return [
			{key, title: event.title, start, end, highlighted: key === highlighted, link: event.link},
		];
	});
}
