import {CalendarDaysIcon} from 'lucide-react';
import {useState} from 'react';
import type {Intent} from '@/client/intent-client';
import type {AgendaEvent, Failure} from '@/client/widgets-client';
import {ConnectWidget} from '@/components/widgets/connect-widget';
import {DayGrid} from '@/components/widgets/day-grid';
import {dayBounds, eventKey, timedItems} from '@/lib/calendar-day';
import {Missing, WidgetFrame} from '@/components/widgets/widget-frame';
import {useAgenda, useEvents, usePeople} from '@/lib/widget-lookups';
import {
	bestMatch,
	dayAsked,
	eventSearches,
	fieldTexts,
	isAddress,
	namesIn,
} from '@/lib/widget-values';

const DAY = new Intl.DateTimeFormat(undefined, {weekday: 'short', month: 'short', day: 'numeric'});
const TIME = new Intl.DateTimeFormat(undefined, {hour: 'numeric', minute: '2-digit'});
// How many more of the events found it offers beside the one it shows.
const MORE = 4;

// "Today", "Tomorrow", else the day: "Fri, Oct 17".
function dayName(day: Date, now: Date): string {
	const offset = Math.round(
		(dayBounds(day).start.getTime() - dayBounds(now).start.getTime()) / 86_400_000,
	);
	const relative = {[-1]: 'Yesterday', 0: 'Today', 1: 'Tomorrow'}[offset];
	return relative ? `${relative} · ${DAY.format(day)}` : DAY.format(day);
}

// When an event is: "Tue, Oct 21 · 3:00 PM", or its day alone for one all day.
function whenOf(event: AgendaEvent): string {
	const start = new Date(event.start);
	if (event.allDay) {
		return DAY.format(new Date(`${event.start}T00:00`));
	}
	return `${DAY.format(start)} · ${TIME.format(start)}`;
}

// An all-day event's day on the person's clock: Google writes it as the day alone.
function startDay(event: AgendaEvent): Date {
	return event.allDay ? new Date(`${event.start}T00:00`) : new Date(event.start);
}

function eachConnection(failures: Failure[]): Failure[] {
	return [...new Map(failures.map((failure) => [failure.connectionId, failure])).values()];
}

// Calendar: a day of every calendar, the one asked about or today; or, asked when something is,
// the day the soonest event the calendars find for it is on, with it highlighted and the next
// few a click away.
export function CalendarWidget({intent, typed, now}: {intent: Intent; typed: string; now: Date}) {
	const names = namesIn(intent, 'meetingWith');
	const [what] = fieldTexts(intent, 'eventName');
	const searching = names.length > 0 || Boolean(what);
	const asked = dayAsked(typed, now);
	const [first] = names;
	// The person is looked up first, so their addresses are searched for too.
	const lookFor = first && !isAddress(first) ? [first] : [];
	const people = usePeople(lookFor.length > 0 ? lookFor : null);
	const searches = eventSearches(intent, people.data);
	const ready = searching && searches.length > 0 && (lookFor.length === 0 || !people.loading);
	const found = useEvents(
		ready ? {from: dayBounds(asked ?? now).start.toISOString(), searches} : null,
	);
	const [picked, setPicked] = useState<string | null>(null);

	const matches = found.data?.events ?? [];
	const shown = matches.find((event) => eventKey(event) === picked) ?? matches[0] ?? null;
	const day = shown ? startDay(shown) : (asked ?? now);
	// Searching, the day waits for what is found, or shows the day asked about when nothing is.
	const showsDay = !searching || shown !== null || (found.data !== null && asked !== null);
	const {start, end} = dayBounds(day);
	const agenda = useAgenda(showsDay ? {from: start.toISOString(), to: end.toISOString()} : null);

	if (agenda.data?.sources.length === 0 || found.data?.sources.length === 0) {
		return (
			<ConnectWidget icon={CalendarDaysIcon} name="Calendar" collectionId="events">
				Connect a calendar to see your days and find your meetings from here.
			</ConnectWidget>
		);
	}

	const highlighted = shown ? eventKey(shown) : null;
	// The event found is on its day whatever the day's read says, and before it is read.
	const read = agenda.data?.events ?? [];
	const events =
		shown && !read.some((event) => eventKey(event) === highlighted) ? [...read, shown] : read;
	const items = timedItems(events, day, highlighted);
	const allDay = events.filter((event) => event.allDay);
	const who = first ? (bestMatch(people.data, first)?.name ?? first) : null;
	const described = [...(who ? [`with ${who}`] : []), ...(what ? [what] : [])].join(' · ');
	const others = matches.filter((event) => event !== shown).slice(0, MORE);
	const failed = eachConnection([...(agenda.data?.failed ?? []), ...(found.data?.failed ?? [])]);

	return (
		<WidgetFrame icon={CalendarDaysIcon} name="Calendar" failed={failed}>
			{searching && (
				<p className="truncate">
					<span className="text-muted-foreground">{what && !who ? 'Next ' : 'Next event '}</span>
					{described}
					{shown ? (
						<span className="text-muted-foreground"> · {whenOf(shown)}</span>
					) : (
						<Missing>
							{' '}
							· {!found.data || found.loading ? 'searching…' : 'nothing coming up'}
						</Missing>
					)}
				</p>
			)}
			{showsDay && (
				<div className="flex min-w-0 flex-col gap-2">
					<p className="flex items-baseline justify-between gap-3">
						<span>{dayName(day, now)}</span>
						<span className="text-muted-foreground">
							{!agenda.data && agenda.loading
								? 'Reading your calendar…'
								: events.length === 0
									? 'Nothing on your calendar'
									: `${events.length} ${events.length === 1 ? 'event' : 'events'}`}
						</span>
					</p>
					{allDay.length > 0 && (
						<p className="truncate text-muted-foreground">
							All day:{' '}
							{allDay.map((event, index) => (
								<span key={eventKey(event)}>
									{index > 0 && ', '}
									<span className={eventKey(event) === highlighted ? 'text-foreground' : ''}>
										{event.title}
									</span>
								</span>
							))}
						</p>
					)}
					<DayGrid items={items} />
				</div>
			)}
			{others.length > 0 && (
				<ul className="flex flex-col gap-1" aria-label="Also found">
					{others.map((event) => (
						<li key={eventKey(event)}>
							<button
								type="button"
								className="flex w-full min-w-0 gap-3 text-left hover:underline"
								onClick={() => setPicked(eventKey(event))}
							>
								<span className="w-40 shrink-0 text-muted-foreground tabular-nums">
									{whenOf(event)}
								</span>
								<span className="min-w-0 truncate">{event.title}</span>
							</button>
						</li>
					))}
				</ul>
			)}
		</WidgetFrame>
	);
}
