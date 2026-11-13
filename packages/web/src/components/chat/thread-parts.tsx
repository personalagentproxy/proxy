import type {ChatAttachment, ThreadStanding} from '@proxy/contracts/harness';
import {attachedParts} from '@proxy/utils/harness';
import {CheckIcon, ClockIcon} from 'lucide-react';
import {Fragment} from 'react';
import {SentChip} from '@/components/chat/attachments';
import {Bubble, BubbleContent} from '@/components/chat/bubble';
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
		<Tooltip>
			<TooltipTrigger
				render={
					<PillButton
						type="button"
						variant="ghost"
						icon
						aria-label={DONE_LABEL}
						onClick={onDone}
						className="size-5 text-muted-foreground"
					/>
				}
			>
				<CheckIcon className="size-3.5" />
			</TooltipTrigger>
			<TooltipContent>{DONE_LABEL}</TooltipContent>
		</Tooltip>
	);
}

/**
 * What the person said, on the left, in a grey bubble, as they typed it, with the files they
 * attached where they put them; outlined where it opened the thread open beside the chat.
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
	return (
		<Bubble
			variant="muted"
			className={cn('max-w-[40rem]', outlined && '*:data-[slot=bubble-content]:border-border')}
		>
			<BubbleContent className="whitespace-pre-wrap">
				{attachedParts(text, attachments).map((part, index) =>
					'text' in part ? (
						<Fragment key={index}>{part.text}</Fragment>
					) : (
						<SentChip key={index} attachment={part.file} />
					),
				)}
			</BubbleContent>
		</Bubble>
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
