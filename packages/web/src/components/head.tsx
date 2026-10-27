import {useEffect, useRef} from 'react';
import type {Look} from '@proxy/utils/harness';
import {cn} from '@proxy/ui/lib/utils';
import {FACING, loadStage, paintHead, pixels, type Pose, REST} from '@/lib/head';

// A persona's head, drawn as the head lab draws it (lib/head.ts). It is decorative: the text
// beside one always names it.

/** A still head, `size` CSS pixels wide, in its pose; at rest unless another is given. */
export function Head({
	look,
	color,
	size,
	pose = REST,
	className,
}: {
	look: Look;
	color: string;
	size: number;
	pose?: Pose;
	className?: string;
}) {
	const ref = useRef<HTMLCanvasElement>(null);
	// Drawn again only when the head itself changes, by value: the page reads its agents again as
	// it goes, and gets new objects of the same heads each time.
	const key = JSON.stringify([look, color, pose]);
	const latest = useRef({look, color, pose});
	useEffect(() => {
		latest.current = {look, color, pose};
	}, [look, color, pose]);
	useEffect(() => {
		let current = true;
		void loadStage().then((stage) => {
			if (!current || !stage || !ref.current) {
				return;
			}
			const spec = latest.current;
			paintHead(
				stage,
				ref.current,
				{look: spec.look, color: spec.color},
				spec.pose,
				pixels(size),
				false,
			);
		});
		return () => {
			current = false;
		};
	}, [key, size]);
	return (
		<canvas
			ref={ref}
			aria-hidden
			className={cn('shrink-0', className)}
			style={{width: size, height: size}}
		/>
	);
}

// How far the head turns toward the cursor, in degrees, at the edge of the window, and how fast
// it follows: the share of the way it goes each frame.
const TURN = 45;
const NOD = 30;
const TILT = 10;
const FOLLOW = 0.15;

// Where the pointer last was on the page, from any move or press since the app loaded, so a head
// that appears, as in a dialog opened by a click, looks at it from its first frame rather than
// waiting for the pointer to move again; and the live heads on the page, each set going again as
// it moves.
let pointer: {x: number; y: number} | null = null;
const wakers = new Set<() => void>();
if (typeof window !== 'undefined') {
	const note = (event: PointerEvent) => {
		pointer = {x: event.clientX, y: event.clientY};
		for (const wake of wakers) {
			wake();
		}
	};
	window.addEventListener('pointermove', note, {passive: true});
	window.addEventListener('pointerdown', note, {passive: true});
}

function clamp(value: number): number {
	return Math.max(-1, Math.min(1, value));
}

// Where the head should look to meet the pointer: turned and nodded toward it by how far it is
// from the head across the window, tilted a little with the turn; at you while the pointer is
// unknown.
function toward(canvas: HTMLCanvasElement): Pose {
	if (pointer === null) {
		return {...FACING};
	}
	const box = canvas.getBoundingClientRect();
	const dx = clamp((pointer.x - (box.left + box.width / 2)) / (window.innerWidth / 2));
	const dy = clamp((pointer.y - (box.top + box.height / 2)) / (window.innerHeight / 2));
	return {rotX: dy * NOD, rotY: FACING.rotY + dx * TURN, rotZ: -dx * TILT};
}

/**
 * A head that looks at the cursor while `watching`: facing you, turning toward the pointer
 * wherever it goes on the page; not watching, it settles back to rest. Either way it is drawn
 * only while it has somewhere to go: once it is where it should look, it stays, drawn no more
 * until the pointer moves, or it is to look elsewhere.
 */
export function LiveHead({
	look,
	color,
	size,
	watching = true,
	className,
}: {
	look: Look;
	color: string;
	size: number;
	watching?: boolean;
	className?: string;
}) {
	const ref = useRef<HTMLCanvasElement>(null);
	// The look, color and whether to watch as they are now, read each frame, so a change shows
	// without restarting; and the loop, to set going again once it has settled: as these change,
	// and as the pointer moves.
	const spec = useRef({look, color});
	const watch = useRef(watching);
	const wake = useRef<(() => void) | null>(null);
	useEffect(() => {
		spec.current = {look, color};
		watch.current = watching;
		wake.current?.();
	}, [look, color, watching]);
	useEffect(() => {
		const canvas = ref.current;
		if (!canvas) {
			return;
		}
		let current = true;
		let running = false;
		let frame = 0;
		// Starts looking at the pointer, or at rest, then goes a share of the way to where it
		// should look each frame.
		const pose = watch.current ? toward(canvas) : {...REST};
		void loadStage().then((stage) => {
			if (!current || !stage) {
				return;
			}
			const tick = () => {
				if (!current) {
					return;
				}
				const target = watch.current ? toward(canvas) : REST;
				const settled =
					Math.abs(target.rotX - pose.rotX) < 0.05 &&
					Math.abs(target.rotY - pose.rotY) < 0.05 &&
					Math.abs(target.rotZ - pose.rotZ) < 0.05;
				if (settled) {
					Object.assign(pose, target);
				}
				if (!settled) {
					pose.rotX += (target.rotX - pose.rotX) * FOLLOW;
					pose.rotY += (target.rotY - pose.rotY) * FOLLOW;
					pose.rotZ += (target.rotZ - pose.rotZ) * FOLLOW;
				}
				paintHead(stage, canvas, spec.current, pose, pixels(size), true);
				if (settled) {
					running = false;
					return;
				}
				frame = requestAnimationFrame(tick);
			};
			wake.current = () => {
				if (running || !current) {
					return;
				}
				running = true;
				frame = requestAnimationFrame(tick);
			};
			wakers.add(wake.current);
			wake.current();
		});
		return () => {
			current = false;
			if (wake.current) {
				wakers.delete(wake.current);
			}
			wake.current = null;
			cancelAnimationFrame(frame);
		};
	}, [size]);
	return (
		<canvas
			ref={ref}
			aria-hidden
			className={cn('shrink-0', className)}
			style={{width: size, height: size}}
		/>
	);
}
