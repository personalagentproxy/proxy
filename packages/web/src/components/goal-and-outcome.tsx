import type {KeyboardEvent} from 'react';
import {AnimatedHeight} from '@/components/animated-height';
import {Tooltip, TooltipContent, TooltipTrigger} from '@proxy/ui/components/tooltip';
import {cn} from '@proxy/ui/lib/utils';

// What a task set out to do and what came of it, one at a time: a switch between the two, and the
// text itself, the one shown fading in and the room it takes growing or shrinking to fit, so
// nothing below jumps. The two are separate so the page can place them apart; the page holds
// which is shown. A task without an outcome yet, under way or left open, has only its
// description: the switch is there, but can't be moved, and says so on hover. The switch is a
// pair of tabs over the text as their panel, tied together by `id`, which the page gives both.

export type ShownText = 'goal' | 'outcome';

const OPTIONS: Array<{id: ShownText; label: string}> = [
	{id: 'goal', label: 'Description'},
	{id: 'outcome', label: 'Outcome'},
];

const tabId = (id: string, shown: ShownText) => `${id}-${shown}`;
const panelId = (id: string) => `${id}-panel`;

/**
 * The switch between the description and the outcome, its highlight sliding to the one chosen;
 * without an outcome to show, the outcome can't be chosen, and hovering it says so. The arrow keys
 * move between the two, as between tabs, and only the one chosen is a stop for the Tab key.
 */
export function TextSwitch({
	id,
	shown,
	hasOutcome,
	onChange,
}: {
	id: string;
	shown: ShownText;
	hasOutcome: boolean;
	onChange: (shown: ShownText) => void;
}) {
	const choose = (next: ShownText) => {
		if (next === 'outcome' && !hasOutcome) {
			return;
		}
		onChange(next);
		document.getElementById(tabId(id, next))?.focus();
	};
	const onKeyDown = (event: KeyboardEvent) => {
		if (event.key === 'ArrowLeft' || event.key === 'Home') {
			event.preventDefault();
			choose('goal');
			return;
		}
		if (event.key === 'ArrowRight' || event.key === 'End') {
			event.preventDefault();
			choose('outcome');
		}
	};
	return (
		<div
			role="tablist"
			aria-label="Description or outcome"
			onKeyDown={onKeyDown}
			className="relative grid w-fit grid-cols-2 rounded-md bg-muted p-0.5 text-xs"
		>
			<span
				aria-hidden
				className={cn(
					'absolute inset-y-0.5 left-0.5 w-[calc(50%-2px)] rounded-sm bg-background shadow-xs transition-transform duration-200 ease-out motion-reduce:transition-none',
					shown === 'outcome' && 'translate-x-full',
				)}
			/>
			{OPTIONS.map((option) => {
				const blocked = option.id === 'outcome' && !hasOutcome;
				const tab = (
					<button
						key={option.id}
						id={tabId(id, option.id)}
						type="button"
						role="tab"
						aria-selected={shown === option.id}
						aria-controls={panelId(id)}
						aria-disabled={blocked || undefined}
						tabIndex={shown === option.id ? 0 : -1}
						onClick={() => {
							if (!blocked) {
								onChange(option.id);
							}
						}}
						className={cn(
							'relative rounded-sm px-2.5 py-0.5 transition-colors duration-200',
							shown === option.id && 'text-foreground',
							shown !== option.id &&
								!blocked &&
								'cursor-pointer text-muted-foreground hover:text-foreground',
							blocked && 'cursor-not-allowed text-muted-foreground/50',
						)}
					>
						{option.label}
					</button>
				);
				if (!blocked) {
					return tab;
				}
				return (
					<Tooltip key={option.id}>
						<TooltipTrigger render={tab} />
						<TooltipContent>Not available</TooltipContent>
					</Tooltip>
				);
			})}
		</div>
	);
}

/** The text chosen, or the description alone where there is no outcome: fading in, in a box that animates to its height. */
export function TextPanel({
	id,
	shown,
	goal,
	outcome,
	className,
}: {
	id: string;
	shown: ShownText;
	goal: string;
	outcome: string | null;
	className?: string;
}) {
	const panel = {
		id: panelId(id),
		role: 'tabpanel',
		'aria-labelledby': tabId(id, outcome === null ? 'goal' : shown),
		className,
	};
	if (outcome === null) {
		return (
			<div {...panel}>
				<p>{goal}</p>
			</div>
		);
	}
	return (
		<div {...panel}>
			<AnimatedHeight open>
				<p key={shown} className="animate-in fade-in-0 duration-200 motion-reduce:animate-none">
					{shown === 'goal' ? goal : outcome}
				</p>
			</AnimatedHeight>
		</div>
	);
}
