import {CalendarIcon, ClockIcon, MapPinIcon} from 'lucide-react';
import {useState} from 'react';
import type {Intent} from '@/client/intent-client';
import {editEvent, type AgendaEvent, type EventChange} from '@/client/widgets-client';
import {Button} from '@proxy/ui/components/button';
import {Input} from '@proxy/ui/components/input';
import {ConnectWidget} from '@/components/widgets/connect-widget';
import {DayAgenda, GuestRow} from '@/components/widgets/event-widget';
import {Avatar, DetailRow, Missing, WidgetFrame} from '@/components/widgets/widget-frame';
import {WidgetSelect} from '@/components/widgets/widget-select';
import {WriteResult} from '@/components/widgets/write-result';
import {dayAround, eventKey, searchFrom} from '@/lib/calendar-day';
import {useAgenda, useEvents, usePeople} from '@/lib/widget-lookups';
import {
	dayAsked,
	eventSearches,
	fieldTexts,
	guestsNamed,
	guestsOf,
	isAddress,
	movedTime,
	namesIn,
} from '@/lib/widget-values';
import {useSuggested} from '@/lib/use-suggested';
import {useWriteStatus, writeErrorMessage} from '@/lib/write-status';

const TIME = new Intl.DateTimeFormat(undefined, {hour: 'numeric', minute: '2-digit'});
const DAY = new Intl.DateTimeFormat(undefined, {weekday: 'short', month: 'short', day: 'numeric'});

type Span = {start: Date; end: Date};

function spanText({start, end}: Span): string {
	return `${DAY.format(start)} · ${TIME.format(start)} – ${TIME.format(end)}`;
}

function sameSpan(a: Span, b: Span): boolean {
	return a.start.getTime() === b.start.getTime() && a.end.getTime() === b.end.getTime();
}

function optionLabel(event: AgendaEvent): string {
	return event.allDay
		? `${event.title} · ${DAY.format(new Date(`${event.start}T00:00`))}`
		: `${event.title} · ${spanText({start: new Date(event.start), end: new Date(event.end)})}`;
}

// Change event: the event meant, found as the Calendar widget finds one, the first the person can
// change unless they pick another; what changes of it, its time, title, place and guests, each
// beside what it was; and the day it moves to, with what it would clash with.
export function EditEventWidget({intent, typed, now}: {intent: Intent; typed: string; now: Date}) {
	const [name] = namesIn(intent, 'changeWith');
	const [what] = fieldTexts(intent, 'changeEvent');
	const [when] = fieldTexts(intent, 'changeFrom');
	const [to] = fieldTexts(intent, 'changeTo');
	const [newTitle] = fieldTexts(intent, 'newTitle');
	const [newLocation] = fieldTexts(intent, 'newLocation');
	const inviting = namesIn(intent, 'invite');
	const uninviting = namesIn(intent, 'uninvite');

	const lookFor = [
		...new Set([name, ...inviting, ...uninviting].filter((one): one is string => Boolean(one))),
	].filter((one) => !isAddress(one));
	const people = usePeople(lookFor.length > 0 ? lookFor : null);
	const searches = eventSearches({name, what}, people.data);
	const from = searchFrom(when ? dayAsked(when, now) : null, now);
	const found = useEvents(
		searches.length > 0 && (lookFor.length === 0 || !people.loading)
			? {from: from.toISOString(), searches}
			: null,
	);
	const [picked, setPicked] = useState<string | null>(null);
	const [chosen, setChosen] = useState<Record<string, string>>({});
	const [status, setStatus] = useWriteStatus(typed);

	const candidates = found.data?.events ?? [];
	const event =
		candidates.find((one) => eventKey(one) === picked) ??
		candidates.find((one) => one.editable) ??
		candidates[0] ??
		null;
	const was =
		event && !event.allDay ? {start: new Date(event.start), end: new Date(event.end)} : null;
	const moved = was && to ? movedTime(to, was, now) : null;
	const time = moved ?? was;
	const agenda = useAgenda(time ? dayAround(time.start) : null);
	const [title, setTitle] = useSuggested(newTitle ?? event?.title ?? '');

	if (found.data?.sources.length === 0) {
		return (
			<ConnectWidget icon={CalendarIcon} name="Change event" collectionIds={['events']}>
				Connect a calendar to change your events from here.
			</ConnectWidget>
		);
	}

	const invited = guestsOf(inviting, people.data, chosen);
	const had = event?.guests ?? [];
	const removed = new Set(uninviting.flatMap((one) => guestsNamed(had, one, people.data)));
	const added = invited.flatMap((guest) =>
		guest.address && !had.includes(guest.address) ? [guest.address] : [],
	);
	const guests = [...had.filter((guest) => !removed.has(guest)), ...added];
	const location = newLocation ?? event?.location ?? '';

	const change: Omit<EventChange, 'connectionId' | 'calendarId' | 'eventId'> = {
		...(event && title.trim() !== '' && title.trim() !== event.title ? {title: title.trim()} : {}),
		...(moved && was && !sameSpan(moved, was)
			? {start: moved.start.toISOString(), end: moved.end.toISOString()}
			: {}),
		...(event && location !== event.location ? {location} : {}),
		...(removed.size > 0 || added.length > 0 ? {guests} : {}),
	};
	const changes = Object.keys(change).length;

	const save = () => {
		if (!event || changes === 0) {
			return;
		}
		setStatus({kind: 'saving'});
		void editEvent({
			connectionId: event.connectionId,
			calendarId: event.calendarId,
			eventId: event.id,
			...change,
		}).then((result) => {
			if (result.isErr()) {
				setStatus({kind: 'failed', message: writeErrorMessage(result.error)});
				return;
			}
			useAgenda.clear();
			useEvents.clear();
			setStatus({
				kind: 'done',
				message: guests.length > 0 || had.length > 0 ? 'Update sent' : 'Event changed',
				link: result.value.link,
			});
		});
	};

	const searching = searches.length > 0 && (!found.data || found.loading);
	const notice = !event
		? null
		: !event.editable
			? 'Only events you organize can be changed here'
			: event.allDay && to
				? 'All-day events can’t be moved here'
				: to && !moved
					? `Couldn’t read “${to}” as a time`
					: null;

	return (
		<WidgetFrame
			icon={CalendarIcon}
			name="Change event"
			failed={found.data?.failed}
			status={notice ? <span>{notice}</span> : <WriteResult status={status} />}
			actions={
				<Button
					size="sm"
					onClick={save}
					disabled={
						!event?.editable || changes === 0 || status.kind === 'saving' || status.kind === 'done'
					}
				>
					{had.length > 0 || guests.length > 0 ? 'Send update' : 'Save'}
				</Button>
			}
		>
			{searches.length === 0 ? (
				<Missing>Say which event, such as “move my 1:1 with Arne to Thursday at 3”.</Missing>
			) : !event ? (
				<Missing>{searching ? 'Looking for the event…' : 'No event coming up matches.'}</Missing>
			) : (
				<>
					{candidates.length > 1 && (
						<DetailRow icon={CalendarIcon}>
							<WidgetSelect
								label="Which event"
								options={candidates.map((one) => ({value: eventKey(one), label: optionLabel(one)}))}
								value={eventKey(event)}
								onChange={setPicked}
							/>
						</DetailRow>
					)}
					<Input
						aria-label="Title"
						value={title}
						onChange={(change) => setTitle(change.target.value)}
					/>
					<div className="grid gap-4 md:grid-cols-2">
						<div className="flex min-w-0 flex-col gap-3">
							<DetailRow icon={ClockIcon}>
								{!time ? (
									<Missing>All day</Missing>
								) : moved && was && !sameSpan(moved, was) ? (
									<>
										<span className="text-muted-foreground line-through">{spanText(was)}</span>
										<br />
										{spanText(moved)}
									</>
								) : (
									spanText(time)
								)}
							</DetailRow>
							<DetailRow icon={MapPinIcon}>
								{event.location !== location && event.location !== '' && (
									<span className="text-muted-foreground line-through">{event.location} </span>
								)}
								{location || <Missing>No location</Missing>}
							</DetailRow>
							<ul className="flex flex-col gap-2" aria-label="Guests">
								{had.map((guest) => (
									<li key={guest} className="flex min-w-0 items-center gap-3">
										<Avatar name={guest} />
										<span
											className={`min-w-0 truncate ${removed.has(guest) ? 'text-muted-foreground line-through' : ''}`}
										>
											{guest}
										</span>
										{removed.has(guest) && (
											<span className="text-muted-foreground">· taken off</span>
										)}
									</li>
								))}
								{invited
									.filter((guest) => !guest.address || !had.includes(guest.address))
									.map((guest) => (
										<GuestRow
											key={guest.name}
											guest={guest}
											loading={people.loading}
											onChoose={(key) => setChosen({...chosen, [guest.name]: key})}
										/>
									))}
								{had.length === 0 && invited.length === 0 && (
									<li className="text-muted-foreground">No guests</li>
								)}
							</ul>
						</div>
						{time && (
							<DayAgenda
								time={time}
								agenda={agenda.data}
								loading={agenda.loading}
								title={title || event.title}
								moving={eventKey(event)}
							/>
						)}
					</div>
				</>
			)}
		</WidgetFrame>
	);
}
