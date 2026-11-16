import type {ChatAttachment, ThreadStanding} from '@proxy/contracts/harness';
import {attachedParts} from '@proxy/utils/harness';
import {ArchiveIcon, BellIcon, CheckIcon, ClockIcon, LoaderCircleIcon} from 'lucide-react';
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
 * Where a thread stands, as a word over it in the list and beside its name in the title bar: in
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
	return <span className="shrink-0 text-xs font-medium text-foreground">Done</span>;
}

/** What says a thread waiting for the person is done, with nothing more to answer: a check. */
export const DONE_LABEL = 'Mark done';

/**
 * The check on a thread waiting for the person in the chat's list, small enough to sit in the line
 * of how many messages it holds and when the last came, its label in a tooltip.
 */
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

// A small icon button in the line under a thread in the chat's list, its label in a tooltip.
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
						className="size-5 text-muted-foreground"
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
 * attached where they put them; outlined where it opened the thread open beside the chat. A file
 * opens in the viewer, which steps through the message's files in the order they sit in it, those
 * deleted since left out.
 */
export function PersonBubble({
	text,
	attachments,
	outlined = false,
}: {
	text: string;
	attachments: ChatAttachment[];
	outlined?: boolean;
}) {
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
			<Bubble
				variant="muted"
				className={cn('max-w-[40rem]', outlined && '*:data-[slot=bubble-content]:border-border')}
			>
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

/** What opened a thread an alert opened, as the chat's list shows it: its title, on one line, by a bell. */
export function AlertOpenerLine({title}: {title: string}) {
	return (
		<p className="flex w-full min-w-0 items-center gap-2 text-sm text-muted-foreground">
			<BellIcon className="size-[15px] shrink-0" aria-label="Opened by an alert" />
			<span className="min-w-0 truncate">{title}</span>
		</p>
	);
}
