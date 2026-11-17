import type {ChatAttachment, ChatThreadState, ThreadStanding} from '@proxy/contracts/harness';
import {attachedParts} from '@proxy/utils/harness';
import {ArchiveIcon, CheckIcon, ClockIcon, LoaderCircleIcon} from 'lucide-react';
import {Fragment, type ReactNode, useMemo, useState} from 'react';
import {Link} from 'react-router';
import {SentChip} from '@/components/chat/attachments';
import {Bubble, BubbleContent} from '@/components/chat/bubble';
import {FileViewer, type ViewedFile} from '@/components/chat/file-viewer';
import {Trace, TraceLine, TraceTitle} from '@/components/chat/trace';
import {PillButton} from '@proxy/ui/components/pill-button';
import {Tooltip, TooltipContent, TooltipTrigger} from '@proxy/ui/components/tooltip';
import {cn} from '@proxy/ui/lib/utils';

// The parts a thread is drawn with, in the chat's list of its threads and open beside it.

/**
 * Where a thread stands, as a word beside its name in the title bar: in
 * progress, grey and shimmering, while it is at work or asleep until it wakes; waiting for you, in
 * orange, where its agent stopped needing the person; done, in ink.
 */
export function ThreadStatus({standing}: {standing: ThreadStanding}) {
	if (standing === 'in_progress') {
		return (
			<span className="shrink-0 text-xs font-medium text-muted-foreground">
				<span className="shimmer motion-reduce:shimmer-none">In progress</span>
			</span>
		);
	}
	if (standing === 'waiting') {
		return <span className="shrink-0 text-xs font-medium text-waiting">Waiting for you</span>;
	}
	if (standing === 'watching') {
		return <span className="shrink-0 text-xs font-medium text-muted-foreground">Watching</span>;
	}
	return <span className="shrink-0 text-xs font-medium text-foreground">Done</span>;
}

// What each of a thread's icons says, for whoever can't see it.
const STATUS_LABELS: Record<ThreadStanding, string> = {
	in_progress: 'In progress',
	waiting: 'Waiting for you',
	watching: 'Watching',
	done: 'Done',
};

/**
 * Where a thread stands, as an icon at the start of its row in the chat's list: in progress, a ring
 * with an arc turning in it, dashed while it is asleep until something wakes it; waiting for you, an
 * orange ring around a dot; watching, the dashed ring alone, as it waits for its alerts to wake it;
 * done, a check in a disc of ink. The word is there for whoever can't see
 * the icon.
 */
export function ThreadStatusIcon({
	standing,
	state,
	className,
}: {
	standing: ThreadStanding;
	state: ChatThreadState;
	className?: string;
}) {
	const asleep = standing === 'in_progress' && state.kind === 'asleep';
	return (
		<>
			<span className="sr-only">{STATUS_LABELS[standing]}</span>
			<svg viewBox="0 0 16 16" aria-hidden className={cn('size-4 shrink-0', className)}>
				{standing === 'done' && (
					<>
						<circle cx="8" cy="8" r="7" className="fill-foreground" />
						<path
							d="M5 8.2 7.2 10.3 11 6"
							fill="none"
							strokeWidth="1.6"
							strokeLinecap="round"
							strokeLinejoin="round"
							className="stroke-background"
						/>
					</>
				)}
				{standing === 'waiting' && (
					<>
						<circle
							cx="8"
							cy="8"
							r="6.25"
							fill="none"
							strokeWidth="1.5"
							className="stroke-waiting"
						/>
						<circle cx="8" cy="8" r="3" className="fill-waiting" />
					</>
				)}
				{(asleep || standing === 'watching') && (
					<circle
						cx="8"
						cy="8"
						r="6.25"
						fill="none"
						strokeWidth="1.5"
						strokeDasharray="2 2.6"
						className="stroke-muted-foreground"
					/>
				)}
				{standing === 'in_progress' && !asleep && (
					<>
						<circle
							cx="8"
							cy="8"
							r="6.25"
							fill="none"
							strokeWidth="1.5"
							className="stroke-border"
						/>
						<path
							d="M8 1.75A6.25 6.25 0 0 1 14.25 8"
							fill="none"
							strokeWidth="1.5"
							strokeLinecap="round"
							className="origin-center animate-spin stroke-muted-foreground [animation-duration:1.4s] motion-reduce:animate-none"
						/>
					</>
				)}
			</svg>
		</>
	);
}

/** What says a thread waiting for the person is done, with nothing more to answer: a check. */
export const DONE_LABEL = 'Mark done';

/** The check on a thread waiting for the person in the chat's list, at the end of its row, its label in a tooltip. */
export function DoneButton({onDone}: {onDone: () => void}) {
	return (
		<RowButton label={DONE_LABEL} onClick={onDone}>
			<CheckIcon className="size-3.5" />
		</RowButton>
	);
}

/** What archives a thread that is done, taking it out of the chat's list until something more comes into it. */
export const ARCHIVE_LABEL = 'Archive';

/** The archive button on a thread that is done in the chat's list, where the check is on one waiting for the person. */
export function ArchiveButton({onArchive}: {onArchive: () => void}) {
	return (
		<RowButton label={ARCHIVE_LABEL} onClick={onArchive}>
			<ArchiveIcon className="size-3.5" />
		</RowButton>
	);
}

// A small icon button at the end of a thread's row in the chat's list, its label in a tooltip. Its
// colours alone are animated: shown in the time's place as the row is hovered, it is hidden the
// moment the time is shown again, not a moment after, as it would be were its visibility.
function RowButton({
	label,
	onClick,
	children,
}: {
	label: string;
	onClick: () => void;
	children: ReactNode;
}) {
	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<PillButton
						type="button"
						variant="ghost"
						icon
						aria-label={label}
						onClick={onClick}
						className="size-6 text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
					/>
				}
			>
				{children}
			</TooltipTrigger>
			<TooltipContent>{label}</TooltipContent>
		</Tooltip>
	);
}

/**
 * What the person said, on the left, in a grey bubble, as they typed it, with the files they
 * attached where they put them. A file opens in the viewer, which steps through the message's files
 * in the order they sit in it, those deleted since left out.
 */
export function PersonBubble({text, attachments}: {text: string; attachments: ChatAttachment[]}) {
	const [viewing, setViewing] = useState<number | null>(null);
	const parts = useMemo(() => attachedParts(text, attachments), [text, attachments]);
	const files = useMemo(
		() =>
			parts.flatMap((part): ViewedFile[] =>
				'file' in part && !part.file.gone ? [{attachment: part.file, alt: ''}] : [],
			),
		[parts],
	);
	return (
		<>
			<Bubble variant="muted" className="max-w-[40rem]">
				<BubbleContent className="whitespace-pre-wrap">
					{parts.map((part, index) => {
						if ('text' in part) {
							return <Fragment key={index}>{part.text}</Fragment>;
						}
						const at = files.findIndex((one) => one.attachment === part.file);
						return (
							<SentChip
								key={index}
								attachment={part.file}
								onOpen={at === -1 ? undefined : () => setViewing(at)}
							/>
						);
					})}
				</BubbleContent>
			</Bubble>
			{files.length > 0 && <FileViewer files={files} index={viewing} onIndex={setViewing} />}
		</>
	);
}

/** Something that came into a thread rather than being said in it, as an alert that fired: a quiet line by a clock. */
export function EventLine({text}: {text: string}) {
	return (
		<p className="flex min-w-0 items-start gap-2 text-sm leading-relaxed text-muted-foreground">
			{/* Centred on the line's first row. */}
			<span className="flex h-[1.625em] shrink-0 items-center">
				<ClockIcon className="size-[15px]" aria-hidden />
			</span>
			<span className="min-w-0">{text}</span>
		</p>
	);
}

// How many alerts are on, in words: "Watching 1 thing in the background".
function alertsRunning(count: number): string {
	return `Watching ${count} ${count === 1 ? 'thing' : 'things'} in the background`;
}

/**
 * At the end of a thread, the alerts that come to it, set in it to wake it later, as a quiet line
 * with a spinner: a link to the Alerts page showing those alone, so the person sees what its agent
 * waits for.
 */
export function AlertsLine({count, to}: {count: number; to: string}) {
	return (
		<Trace>
			<Link to={to}>
				<TraceLine>
					<LoaderCircleIcon className="size-3.5 shrink-0 motion-safe:animate-spin" aria-hidden />
					<TraceTitle>{alertsRunning(count)}</TraceTitle>
				</TraceLine>
			</Link>
		</Trace>
	);
}
