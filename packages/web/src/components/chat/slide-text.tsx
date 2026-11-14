import {useEffect, useState} from 'react';
import {cn} from '@proxy/ui/lib/utils';

// How long a change slides for, and how, as the copy that leaves and the one that comes share it.
const SLIDE_MS = 250;
const SLIDE = 'duration-250 ease-[cubic-bezier(0.4,0,0.2,1)] motion-reduce:animate-none';

function reducedMotion(): boolean {
	return (
		typeof window !== 'undefined' &&
		typeof window.matchMedia === 'function' &&
		window.matchMedia('(prefers-reduced-motion: reduce)').matches
	);
}

/**
 * Text that slides to what it says as it changes: what it said slides up out of its box, and what
 * it says now slides up into it from below, in a quarter of a second, the two copies in one cell
 * so the box is as tall as the taller while they pass. It shows `text` as it is when it first
 * draws, or slides to it there from `from`, what stood in its place before it was drawn, as a
 * thread's message does as its title comes. Changed again midway, the copy that was coming is the
 * one that leaves. With less motion asked for, the new text is there at once. The copy leaving is
 * hidden from what reads the page out. `className` styles the box, `copyClassName` each copy, as
 * where it is cut to its lines.
 */
export function SlideText({
	text,
	from,
	className,
	copyClassName,
}: {
	text: string;
	from?: string | null;
	className?: string;
	copyClassName?: string;
}) {
	const [current, setCurrent] = useState(from ?? text);
	const [leaving, setLeaving] = useState<string | null>(null);
	// Which change is sliding, so each slides afresh however soon the next comes.
	const [change, setChange] = useState(0);
	if (current !== text) {
		setCurrent(text);
		setLeaving(reducedMotion() ? null : current);
		setChange(change + 1);
	}

	useEffect(() => {
		if (leaving === null) {
			return;
		}
		const timer = setTimeout(() => setLeaving(null), SLIDE_MS);
		return () => clearTimeout(timer);
	}, [leaving, change]);

	return (
		<span data-slot="slide-text" className={cn('inline-grid overflow-hidden', className)}>
			{leaving !== null && (
				<span
					key={`out-${change}`}
					aria-hidden
					data-slot="slide-text-leaving"
					className={cn(
						'animate-out fill-mode-forwards slide-out-to-top-full [grid-area:1/1]',
						SLIDE,
						copyClassName,
					)}
				>
					{leaving}
				</span>
			)}
			<span
				key={`in-${change}`}
				className={cn(
					'[grid-area:1/1]',
					leaving !== null && cn('animate-in slide-in-from-bottom-full', SLIDE),
					copyClassName,
				)}
			>
				{current}
			</span>
		</span>
	);
}
