import {
	BuildingIcon,
	InboxIcon,
	MailIcon,
	MapPinIcon,
	PencilLineIcon,
	PhoneIcon,
	UserRoundIcon,
	type LucideIcon,
} from 'lucide-react';
import {useState, type ReactNode} from 'react';
import {IconButton} from '@/components/icon-button';
import type {Intent} from '@/client/intent-client';
import {buttonVariants} from '@proxy/ui/components/button';
import {ConnectWidget} from '@/components/widgets/connect-widget';
import {Avatar, DetailRow, Missing, WidgetFrame} from '@/components/widgets/widget-frame';
import {usePeople} from '@/lib/widget-lookups';
import {fieldTexts, matchesFor, personKey} from '@/lib/widget-values';

// Person: who someone is and how to reach them, found by the name as written in every contact
// book, or among the people in the email of every mailbox, the closest first, the others a click
// away. Each address leads on to the emails from it, or to writing to it, by typing that in anew.
export function PersonWidget({intent, onAsk}: {intent: Intent; onAsk: (text: string) => void}) {
	const [name] = fieldTexts(intent, 'person');
	const people = usePeople(name ? [name] : null);
	const [picked, setPicked] = useState<string | null>(null);
	const matches = name ? matchesFor(people.data, name) : [];
	const contact = matches.find((match) => personKey(match) === picked) ?? matches[0] ?? null;
	const others = matches.filter((match) => match !== contact);

	if (people.data?.sources.length === 0) {
		return (
			<ConnectWidget icon={UserRoundIcon} name="Person" collectionIds={['contacts']}>
				Connect your contacts to look people up from here.
			</ConnectWidget>
		);
	}

	return (
		<WidgetFrame
			icon={UserRoundIcon}
			name="Person"
			failed={people.data?.failed}
			actions={
				contact?.link && (
					<a
						href={contact.link}
						target="_blank"
						rel="noreferrer"
						className={buttonVariants({size: 'sm'})}
					>
						Open contact
					</a>
				)
			}
		>
			{!contact && (
				<Missing>
					{!name
						? 'Type a name to look someone up'
						: people.loading
							? `Looking for “${name}”…`
							: `No contact named “${name}”`}
				</Missing>
			)}
			{contact && (
				<>
					<div className="flex items-center gap-3">
						<Avatar name={contact.name} large />
						<div className="min-w-0">
							<p className="truncate font-medium">{contact.name}</p>
							<p className="truncate text-muted-foreground">
								{contact.origin === 'email'
									? 'In your email, not in your contacts'
									: [contact.jobTitle, contact.company].filter(Boolean).join(' · ')}
							</p>
						</div>
					</div>
					<div className="flex flex-col gap-3">
						{contact.emails.map((email, index) => (
							<ListRow key={email} icon={index === 0 ? MailIcon : null}>
								<span className="min-w-0 flex-1 truncate">{email}</span>
								<IconButton
									size="xs"
									label={`Find emails from ${email}`}
									onClick={() => onAsk(`find emails from ${email}`)}
								>
									<InboxIcon />
								</IconButton>
								<IconButton
									size="xs"
									label={`Write to ${email}`}
									onClick={() => onAsk(`write an email to ${email}`)}
								>
									<PencilLineIcon />
								</IconButton>
							</ListRow>
						))}
						{contact.phones.map((phone, index) => (
							<ListRow key={phone} icon={index === 0 ? PhoneIcon : null}>
								<span className="min-w-0 flex-1 truncate">{phone}</span>
							</ListRow>
						))}
						{contact.addresses[0] && (
							<DetailRow icon={MapPinIcon}>{contact.addresses[0]}</DetailRow>
						)}
						{contact.origin === 'contacts' &&
							contact.emails.length === 0 &&
							contact.phones.length === 0 &&
							!contact.company && (
								<DetailRow icon={BuildingIcon}>
									<Missing>Nothing more in the contact</Missing>
								</DetailRow>
							)}
					</div>
					{others.length > 0 && (
						<p className="flex flex-wrap items-center gap-x-1 text-muted-foreground">
							Or
							{others.map((other, index) => (
								<button
									key={personKey(other)}
									type="button"
									className="underline-offset-4 hover:text-foreground hover:underline"
									onClick={() => setPicked(personKey(other))}
								>
									{other.name}
									{index < others.length - 1 ? ',' : ''}
								</button>
							))}
						</p>
					)}
				</>
			)}
		</WidgetFrame>
	);
}

// One of a list of addresses or numbers, one a line, the list's icon on its first line alone.
function ListRow({icon: Icon, children}: {icon: LucideIcon | null; children: ReactNode}) {
	return (
		<div className="flex min-w-0 items-center gap-3">
			{Icon ? (
				<Icon className="size-4 shrink-0 text-muted-foreground" />
			) : (
				<span className="size-4 shrink-0" />
			)}
			{children}
		</div>
	);
}
