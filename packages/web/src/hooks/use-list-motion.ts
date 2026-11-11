import {type RefObject, useLayoutEffect, useRef} from 'react';

// How long a row takes to move, come or go, and how: fast at first, coming gently to rest.
const MOTION: KeyframeAnimationOptions = {duration: 200, easing: 'cubic-bezier(0.2, 0, 0, 1)'};

// A row as it was last laid out, within the list, wherever the list is scrolled to.
type Placed = {element: HTMLElement; top: number; left: number; width: number; height: number};

// The list as it was last laid out: its rows by their keys, and the keys in the order drawn.
type Layout = {order: string; rows: Map<string, Placed>};

// What a row is in the middle of: sliding to a new place, or being uncovered as it comes.
const slides = new WeakMap<HTMLElement, Animation>();
const wipes = new WeakMap<HTMLElement, Animation[]>();

// Whether the person has not asked for less motion.
function mayMove(): boolean {
	return !globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

function keyOf(row: HTMLElement): string {
	return row.dataset.row ?? '';
}

// How far from where it is laid out the row is drawn, by a slide under way.
function slideOffset(list: HTMLElement, row: HTMLElement): number {
	if (slides.get(row)?.playState !== 'running') {
		return 0;
	}
	const laidOut =
		list.getBoundingClientRect().top + list.clientTop - list.scrollTop + row.offsetTop;
	return row.getBoundingClientRect().top - laidOut;
}

// Whether a row came or went where another was or is: the two change places without moving.
function sharesPlace(place: Placed, others: Placed[]): boolean {
	return others.some((other) => Math.abs(other.top - place.top) < 1);
}

// Slides the row from where it was drawn, `by` pixels off, to where it is laid out now.
function slide(row: HTMLElement, by: number): void {
	slides.get(row)?.cancel();
	if (Math.abs(by) < 0.5) {
		return;
	}
	// One still being uncovered is there in full from here on.
	for (const wipe of wipes.get(row) ?? []) {
		wipe.cancel();
	}
	slides.set(
		row,
		row.animate([{transform: `translateY(${by}px)`}, {transform: 'translateY(0)'}], MOTION),
	);
}

// Uncovers a row from its top, at the pace of the rows below it moving down: the row is a window
// that comes down over its content, which stays where it is by moving the other way within it,
// and fades in. Backwards, the row is covered from its bottom, and stays so.
function wipe(row: HTMLElement, content: Element, backwards: boolean): [Animation, Animation] {
	const height = row.offsetHeight;
	const window: Keyframe[] = [
		{transform: `translateY(${-height}px)`},
		{transform: 'translateY(0)'},
	];
	const inside: Keyframe[] = [
		{transform: `translateY(${height}px)`, opacity: 0},
		{transform: 'translateY(0)', opacity: 1},
	];
	if (!backwards) {
		return [row.animate(window, MOTION), content.animate(inside, MOTION)];
	}
	const kept: KeyframeAnimationOptions = {...MOTION, fill: 'forwards'};
	return [row.animate(window.toReversed(), kept), content.animate(inside.toReversed(), kept)];
}

// A row that came: uncovered where the rows after it make room, or, in the place of one that
// went, faded in over it.
function enter(row: HTMLElement, fade: boolean): void {
	const content = row.firstElementChild;
	if (fade || content === null) {
		row.animate([{opacity: 0}, {opacity: 1}], MOTION);
		return;
	}
	// The row clips its content only while it is a window over it.
	row.style.overflow = 'hidden';
	const uncovering = wipe(row, content, false);
	const settle = () => {
		row.style.overflow = '';
	};
	uncovering[0].onfinish = settle;
	uncovering[0].oncancel = settle;
	wipes.set(row, uncovering);
}

// A row that went: kept where it was, over the list, out of reach, until it is covered, or, where
// another came in its place, has faded out.
function leave(list: HTMLElement, place: Placed, fade: boolean): void {
	const ghost = place.element;
	const content = ghost.firstElementChild;
	ghost.removeAttribute('data-row');
	ghost.setAttribute('aria-hidden', 'true');
	ghost.inert = true;
	Object.assign(ghost.style, {
		position: 'absolute',
		top: `${place.top}px`,
		left: `${place.left}px`,
		width: `${place.width}px`,
		height: `${place.height}px`,
		margin: '0',
		overflow: 'hidden',
	});
	list.append(ghost);
	const going =
		fade || content === null
			? ghost.animate([{opacity: 1}, {opacity: 0}], {...MOTION, fill: 'forwards'})
			: wipe(ghost, content, true)[0];
	going.onfinish = () => ghost.remove();
	going.oncancel = () => ghost.remove();
}

/**
 * Moves the rows of a list rather than letting them jump. The ref is the list's, which scrolls
 * and is what its rows are placed against (`relative`); every row in it says which it is
 * (`data-row`, a key no other row of the list has), holds one element, its content, and is in no
 * other row. As the list is drawn again with a row more, the row is uncovered while those after it
 * slide down to make room; with a row fewer, the row is kept where it was, out of reach, and
 * covered while those after it slide up; rows that change places slide to their new ones; and a
 * row that takes another's place fades in over it. Nothing moves as the list first shows, or
 * where the person asked for less motion.
 *
 * The rows are laid out where they end up at once, and only drawn elsewhere on the way there
 * (transform and opacity), so the browser moves them without the page's thread: a page busy
 * drawing what was just opened doesn't hold them up, as it would a row growing in height.
 */
export function useListMotion<T extends HTMLElement>(): RefObject<T | null> {
	const ref = useRef<T>(null);
	const last = useRef<Layout | null>(null);

	// After every draw: rows only come, go or change places as the keys drawn do.
	useLayoutEffect(() => {
		const list = ref.current;
		if (list === null) {
			return;
		}

		const rows = [...list.querySelectorAll<HTMLElement>('[data-row]')];
		const order = rows.map(keyOf).join('\n');
		const before = last.current;
		if (before?.order === order) {
			return;
		}

		const placed = new Map(
			rows.map((row): [string, Placed] => [
				keyOf(row),
				{
					element: row,
					top: row.offsetTop,
					left: row.offsetLeft,
					width: row.offsetWidth,
					height: row.offsetHeight,
				},
			]),
		);
		last.current = {order, rows: placed};
		if (before === null || !mayMove()) {
			return;
		}

		const came = [...placed].filter(([key]) => !before.rows.has(key)).map(([, place]) => place);
		const went = [...before.rows].filter(([key]) => !placed.has(key)).map(([, place]) => place);
		// Read before anything is moved, so no row is laid out again for the next.
		const moves = [...placed].flatMap(([key, {element, top}]) => {
			const was = before.rows.get(key);
			return was ? [{row: element, by: was.top + slideOffset(list, element) - top}] : [];
		});
		for (const {row, by} of moves) {
			slide(row, by);
		}
		for (const place of came) {
			enter(place.element, sharesPlace(place, went));
		}
		for (const place of went) {
			leave(list, place, sharesPlace(place, came));
		}
	});

	return ref;
}
