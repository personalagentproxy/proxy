import {type KeyboardEvent, type PointerEvent, useRef} from 'react';
import {cn} from '@proxy/ui/lib/utils';

type Props = {
	label: string;
	// Which way the column grows as the handle moves right: the navigation, at the window's left,
	// with it; a column at the right, as a thread beside its chat, against it.
	grows: 'right' | 'left';
	// The column's width now, in pixels, as a drag starts.
	measure: () => number;
	// The narrowest and the widest the column may be, as a drag starts.
	bounds: () => {min: number; max: number};
	// The column's width while it is dragged, set on the page itself rather than through React, so
	// the drag keeps up with the pointer.
	apply: (width: number) => void;
	// The width the person left it at, once they let go, or null to give the column its own width
	// back, as a double click does.
	commit: (width: number | null) => void;
	className?: string;
};

// How far the arrow keys move the handle, in pixels.
const STEP = 16;

/**
 * A line between two columns the person drags to make one wider or narrower, or moves with the
 * arrow keys once focused. While it is dragged the page is marked (`data-resizing` on the root,
 * index.css): the pointer stays a resize cursor wherever it goes, nothing is selected, and what
 * slides as the navigation folds keeps up with the pointer rather than easing after it.
 */
export function ResizeHandle({label, grows, measure, bounds, apply, commit, className}: Props) {
	const drag = useRef<{x: number; width: number; min: number; max: number; last: number} | null>(
		null,
	);
	const sign = grows === 'right' ? 1 : -1;

	const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
		if (event.button !== 0) {
			return;
		}
		event.preventDefault();
		event.currentTarget.setPointerCapture(event.pointerId);
		const width = measure();
		drag.current = {x: event.clientX, width, ...bounds(), last: width};
		event.currentTarget.dataset.dragging = '';
		document.documentElement.dataset.resizing = '';
	};

	const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
		const start = drag.current;
		if (!start) {
			return;
		}
		const width = clamp(start.width + sign * (event.clientX - start.x), start.min, start.max);
		start.last = width;
		apply(width);
	};

	const onPointerEnd = (event: PointerEvent<HTMLDivElement>) => {
		const start = drag.current;
		if (!start) {
			return;
		}
		drag.current = null;
		event.currentTarget.releasePointerCapture(event.pointerId);
		delete event.currentTarget.dataset.dragging;
		delete document.documentElement.dataset.resizing;
		// A click without a move leaves the column as it was, its own width included.
		if (start.last === start.width) {
			return;
		}
		commit(start.last);
	};

	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') {
			return;
		}
		event.preventDefault();
		const {min, max} = bounds();
		const towards = event.key === 'ArrowRight' ? 1 : -1;
		commit(clamp(measure() + sign * towards * STEP, min, max));
	};

	return (
		<div
			role="separator"
			aria-orientation="vertical"
			aria-label={label}
			title="Drag to resize, double-click to reset"
			tabIndex={0}
			onPointerDown={onPointerDown}
			onPointerMove={onPointerMove}
			onPointerUp={onPointerEnd}
			onPointerCancel={onPointerEnd}
			onDoubleClick={() => commit(null)}
			onKeyDown={onKeyDown}
			className={cn(
				'w-2 cursor-col-resize touch-none outline-none',
				// The line itself, drawn by the columns; the handle lights it up under the pointer, while
				// it is dragged and once focused.
				'after:absolute after:inset-y-0 after:left-1/2 after:w-0.5 after:-translate-x-1/2 after:transition-colors',
				'hover:after:bg-ring focus-visible:after:bg-ring data-dragging:after:bg-ring',
				className,
			)}
		/>
	);
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(Math.max(value, min), Math.max(min, max));
}
