import {CalendarIcon, ClockIcon, MapPinIcon} from 'lucide-react';
import type {Intent} from '@/client/intent-client';
import {
	createEvent,
	type Agenda,
	type AgendaEvent,
	type People,
	type Person,
} from '@/client/widgets-client';
import {Button} from '@proxy/ui/components/button';
import {Input} from '@proxy/ui/components/input';
import {ConnectWidget} from '@/components/widgets/connect-widget';
import {Avatar, DetailRow, Missing, WidgetFrame} from '@/components/widgets/widget-frame';
import {WidgetSelect} from '@/components/widgets/widget-select';
import {WriteResult} from '@/components/widgets/write-result';
import {useAgenda, usePeople} from '@/lib/widget-lookups';
import {
	eventTime,
	fieldTexts,
	isAddress,
	matchesFor,
	namesIn,
	personKey,
	type EventTime,
} from '@/lib/widget-values';
import {useSuggested} from '@/lib/use-suggested';
import {useWriteStatus, writeErrorMessage} from '@/lib/write-status';
import {useState} from 'react';

const HOUR_PX = 28;
const TIME = new Intl.DateTimeFormat(undefined, {hour: 'numeric', minute: '2-digit'});
const DAY = new Intl.DateTimeFormat(undefined, {weekday: 'short', month: 'short', day: 'numeric'});

// The day a time falls on, from its midnight to the next, on the person's clock.
function dayAround(date: Date): {from: string; to: string} {
	const from = new Date(date);
	from.setHours(0, 0, 0, 0);
	const to = new Date(from);
	to.setDate(to.getDate() + 1);
	return {from: from.toISOString(), to: to.toISOString()};
}

// A guest as the widget shows them: the contact a name stands for, picked among those it found,
// or an address typed as it is.
type Guest = {name: string; person: Person | null; address: string | null; matches: Person[]};

function guestsOf(names: string[], people: People | null, chosen: Record<string, string>): Guest[] {
	return names.map((name) => {
		if (isAddress(name)) {
			return {name, person: null, address: name, matches: []};
		}
		const matches = matchesFor(people, name);
		const person = matches.find((match) => personKey(match) === chosen[name]) ?? matches[0] ?? null;
		return {name, person, address: person?.emails[0] ?? null, matches};
	});
}

// Where the event can go: every calendar the person can write to, named with its account where
// there are several.
type CalendarOption = {value: string; label: string; connectionId: string; calendarId: string};

function calendarValue(connectionId: string, calendarId: string): string {
	return `${connectionId} ${calendarId}`;
}

function calendarOptions(agenda: Agenda | null): CalendarOption[] {
	const writable = agenda?.calendars.filter((calendar) => calendar.writable) ?? [];
	const accounts = new Set(writable.map((calendar) => calendar.connectionId));
	return writable.map((calendar) => {
		const account = agenda?.sources.find((source) => source.connectionId === calendar.connectionId);
		return {
			value: calendarValue(calendar.connectionId, calendar.id),
			// A primary calendar is named after its account already.
			label:
				accounts.size > 1 && account && calendar.name !== account.account
					? `${calendar.name} · ${account.account}`
					: calendar.name,
			connectionId: calendar.connectionId,
			calendarId: calendar.id,
		};
	});
}

// New event: the title, when, who and where, the day it falls on with what is already in every
// calendar, so a clash shows before the invite goes out, and the calendar it goes in.
export function EventWidget({intent, typed, now}: {intent: Intent; typed: string; now: Date}) {
	const names = namesIn(intent, 'attendees');
	const people = usePeople(names.length > 0 ? names : null);
	const [chosen, setChosen] = useState<Record<string, string>>({});
	const guests = guestsOf(names, people.data, chosen);
	const time = eventTime(typed, now);
	const agenda = useAgenda(dayAround(time?.start ?? now));
	const [picked, setPicked] = useState<string | null>(null);
	const [location = ''] = fieldTexts(intent, 'location');
	const [title] = fieldTexts(intent, 'title');
	const firstNames = guests.map((guest) => (guest.person?.name ?? guest.name).split(' ')[0]);
	const [edited, setTitle] = useSuggested(
		title ?? (firstNames.length > 0 ? `${firstNames.join(', ')} and me` : 'New meeting'),
	);
	const [status, setStatus] = useWriteStatus(typed);

	if (agenda.data?.sources.length === 0) {
		return (
			<ConnectWidget icon={CalendarIcon} name="New event" collectionId="events">
				Connect a calendar to see your day and send invites from here.
			</ConnectWidget>
		);
	}

	const options = calendarOptions(agenda.data);
	const target = agenda.data?.target;
	const calendar =
		options.find((option) => option.value === picked) ??
		options.find(
			(option) => target && option.value === calendarValue(target.connectionId, target.calendarId),
		) ??
		null;
	const invited = guests.flatMap((guest) => (guest.address ? [guest.address] : []));

	const create = () => {
		if (!time || !calendar) {
			return;
		}
		setStatus({kind: 'saving'});
		void createEvent({
			connectionId: calendar.connectionId,
			calendarId: calendar.calendarId,
			title: edited.trim(),
			start: time.start.toISOString(),
			end: time.end.toISOString(),
			location,
			guests: invited,
		}).then((result) => {
			if (result.isErr()) {
				setStatus({kind: 'failed', message: writeErrorMessage(result.error)});
				return;
			}
			useAgenda.clear();
			setStatus({
				kind: 'done',
				message: invited.length > 0 ? 'Invite sent' : 'Event created',
				link: result.value.link,
			});
		});
	};

	return (
		<WidgetFrame
			icon={CalendarIcon}
			name="New event"
			failed={agenda.data?.failed}
			status={<WriteResult status={status} />}
			actions={
				<Button
					size="sm"
					onClick={create}
					disabled={
						!time ||
						!calendar ||
						edited.trim() === '' ||
						status.kind === 'saving' ||
						status.kind === 'done'
					}
				>
					{invited.length > 0 ? 'Send invite' : 'Create event'}
				</Button>
			}
		>
			<Input aria-label="Title" value={edited} onChange={(event) => setTitle(event.target.value)} />
			<div className="grid gap-4 md:grid-cols-2">
				<div className="flex min-w-0 flex-col gap-3">
					<DetailRow icon={ClockIcon}>
						{time ? (
							<>
								{DAY.format(time.start)} · {TIME.format(time.start)} – {TIME.format(time.end)}
								{time.hourGuessed && <span className="text-muted-foreground"> · suggested</span>}
							</>
						) : (
							<Missing>No time yet</Missing>
						)}
					</DetailRow>
					<DetailRow icon={MapPinIcon}>{location || <Missing>No location</Missing>}</DetailRow>
					{options.length > 1 && (
						<DetailRow icon={CalendarIcon}>
							<WidgetSelect
								label="Calendar"
								options={options}
								value={calendar?.value ?? null}
								onChange={setPicked}
							/>
						</DetailRow>
					)}
					<ul className="flex flex-col gap-2" aria-label="Guests">
						<li className="flex items-center gap-3">
							<Avatar name="Me" />
							<span>
								Me <span className="text-muted-foreground">· organizer</span>
							</span>
						</li>
						{guests.map((guest) => (
							<GuestRow
								key={guest.name}
								guest={guest}
								loading={people.loading}
								onChoose={(key) => setChosen({...chosen, [guest.name]: key})}
							/>
						))}
					</ul>
				</div>
				{time ? <DayAgenda time={time} agenda={agenda.data} loading={agenda.loading} /> : null}
			</div>
		</WidgetFrame>
	);
}

function GuestRow({
	guest,
	loading,
	onChoose,
}: {
	guest: Guest;
	loading: boolean;
	onChoose: (key: string) => void;
}) {
	const shown = guest.person?.name ?? guest.name;
	return (
		<li className="flex min-w-0 items-center gap-3">
			<Avatar name={shown} />
			{guest.matches.length > 1 && guest.person ? (
				<WidgetSelect
					label={`Which ${guest.name}`}
					options={guest.matches.map((match) => ({
						value: personKey(match),
						label: `${match.name} · ${match.emails[0] ?? 'no address'}`,
					}))}
					value={personKey(guest.person)}
					onChange={onChoose}
				/>
			) : (
				<span className="min-w-0 truncate">
					{shown}{' '}
					<span className="text-muted-foreground">
						· {guest.address ?? (loading ? 'looking…' : 'not in your contacts, not invited')}
					</span>
				</span>
			)}
		</li>
	);
}

function hours(date: Date): number {
	return date.getHours() + date.getMinutes() / 60;
}

type Timed = {title: string; start: Date; end: Date};

function timedOn(events: AgendaEvent[], time: EventTime): Timed[] {
	const day = new Date(time.start);
	day.setHours(0, 0, 0, 0);
	const next = new Date(day);
	next.setDate(next.getDate() + 1);
	return events.flatMap((event) => {
		if (event.allDay) {
			return [];
		}
		const start = new Date(Math.max(Date.parse(event.start), day.getTime()));
		const end = new Date(Math.min(Date.parse(event.end), next.getTime() - 60_000));
		return end > start ? [{title: event.title, start, end}] : [];
	});
}

function overlaps(item: Timed, time: EventTime): boolean {
	return item.start < time.end && time.start < item.end;
}

// The event's day from 9 to 6, widened to take in it and the day's events, with them beside it.
function DayAgenda({
	time,
	agenda,
	loading,
}: {
	time: EventTime;
	agenda: Agenda | null;
	loading: boolean;
}) {
	const items = timedOn(agenda?.events ?? [], time);
	const allDay = agenda?.events.filter((event) => event.allDay) ?? [];
	const from = Math.min(
		9,
		Math.floor(hours(time.start)),
		...items.map((item) => Math.floor(hours(item.start))),
	);
	const to = Math.max(
		18,
		Math.ceil(hours(time.end)),
		...items.map((item) => Math.ceil(hours(item.end))),
	);
	const clashes = items.filter((item) => overlaps(item, time));
	const top = (date: Date) => (hours(date) - from) * HOUR_PX;
	const height = (start: Date, end: Date) => Math.max((hours(end) - hours(start)) * HOUR_PX, 18);

	return (
		<div className="flex min-w-0 flex-col gap-2">
			{allDay.length > 0 && (
				<p className="truncate text-muted-foreground">
					All day: {allDay.map((event) => event.title).join(', ')}
				</p>
			)}
			<div className="relative" style={{height: (to - from) * HOUR_PX}} aria-label="Day">
				{Array.from({length: to - from}, (_, index) => (
					<div
						key={index}
						className="absolute inset-x-0 border-t text-muted-foreground"
						style={{top: index * HOUR_PX}}
					>
						<span className="text-xs">{TIME.format(new Date(2000, 0, 1, from + index))}</span>
					</div>
				))}
				{items.map((item, index) => (
					<div
						key={`${item.title}-${index}`}
						className="absolute right-0 left-16 truncate rounded-md bg-muted px-2 text-muted-foreground"
						style={{top: top(item.start), height: height(item.start, item.end)}}
					>
						{item.title}
					</div>
				))}
				<div
					className={`absolute right-0 truncate rounded-md bg-primary px-2 text-primary-foreground ${clashes.length > 0 ? 'left-1/2' : 'left-16'}`}
					style={{top: top(time.start), height: height(time.start, time.end)}}
				>
					New event
				</div>
			</div>
			<p className="text-muted-foreground">
				{!agenda && loading
					? 'Reading your calendar…'
					: clashes.length > 0
						? `Clashes with ${clashes.map((item) => item.title).join(' and ')}`
						: 'Free then'}
			</p>
		</div>
	);
}
