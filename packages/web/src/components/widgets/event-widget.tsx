import {CalendarIcon, ClockIcon, MapPinIcon} from 'lucide-react';
import type {Intent} from '@/client/intent-client';
import {createEvent, type Agenda} from '@/client/widgets-client';
import {Button} from '@proxy/ui/components/button';
import {Input} from '@proxy/ui/components/input';
import {ConnectWidget} from '@/components/widgets/connect-widget';
import {DayGrid} from '@/components/widgets/day-grid';
import {dayAround, timedItems, type DayItem} from '@/lib/calendar-day';
import {Avatar, DetailRow, Missing, WidgetFrame} from '@/components/widgets/widget-frame';
import {WidgetSelect} from '@/components/widgets/widget-select';
import {WriteResult} from '@/components/widgets/write-result';
import {useAgenda, usePeople} from '@/lib/widget-lookups';
import {eventTime, fieldTexts, guestsOf, namesIn, personKey, type Guest} from '@/lib/widget-values';
import {useSuggested} from '@/lib/use-suggested';
import {useWriteStatus, writeErrorMessage} from '@/lib/write-status';
import {useState} from 'react';
import {useOrgSlug} from '@/hooks/use-org';

const TIME = new Intl.DateTimeFormat(undefined, {hour: 'numeric', minute: '2-digit'});
const DAY = new Intl.DateTimeFormat(undefined, {weekday: 'short', month: 'short', day: 'numeric'});

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
	const org = useOrgSlug();
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
			<ConnectWidget icon={CalendarIcon} name="New event" collectionIds={['events']}>
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
		void createEvent(org, {
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

export function GuestRow({
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

// The event's day with the day's events beside it, and what it clashes with. An event being moved
// (`moving`, its key) is left out, so it doesn't clash with itself, and shows where it goes as `title`.
export function DayAgenda({
	time,
	agenda,
	loading,
	title = 'New event',
	moving = null,
}: {
	time: {start: Date; end: Date};
	agenda: Agenda | null;
	loading: boolean;
	title?: string;
	moving?: string | null;
}) {
	const items = timedItems(agenda?.events ?? [], time.start, null).filter(
		(item) => item.key !== moving,
	);
	const allDay = agenda?.events.filter((event) => event.allDay) ?? [];
	const clashes = items.filter((item) => item.start < time.end && time.start < item.end);
	const proposed: DayItem = {
		key: 'new',
		title,
		start: time.start,
		end: time.end,
		highlighted: true,
		link: null,
	};

	return (
		<div className="flex min-w-0 flex-col gap-2">
			{allDay.length > 0 && (
				<p className="truncate text-muted-foreground">
					All day: {allDay.map((event) => event.title).join(', ')}
				</p>
			)}
			<DayGrid items={[...items, proposed]} />
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
