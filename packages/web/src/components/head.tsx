import {useCallback, useEffect, useRef, useSyncExternalStore} from 'react';
import type {Look} from '@proxy/utils/harness';
import {cn} from '@proxy/ui/lib/utils';
import {
	BLINK_MS,
	blinkAmount,
	FACING,
	FIRST_HOVER_DURATION_MS,
	followAmount,
	followTime,
	loadStage,
	nextBlinkDelay,
	paintHead,
	pixels,
	poseTowardPointer,
	type Pose,
	REST,
	redrawVersion,
	subscribeRedraw,
} from '@/lib/head';

// A persona's head, drawn as lib/head.ts draws it. It is decorative: the text
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
	const redraws = useSyncExternalStore(subscribeRedraw, redrawVersion);
	// Drawn again only when the head itself changes, by value, or the page's theme does:
	// the page reads its agents again as it goes, and gets new objects of the same heads each time.
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
	}, [key, size, redraws]);
	return (
		<canvas
			ref={ref}
			aria-hidden
			className={cn('shrink-0', className)}
			style={{width: size, height: size}}
		/>
	);
}

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

// Where the head should look to meet the pointer: turned and nodded toward it by how far it is
// from the head across its own bounds, tilted a little with the turn; at you while the pointer is
// unknown. Live heads only watch while hovered, so their bounds are the full available range.
function toward(canvas: HTMLCanvasElement, tracking: 'head' | 'viewport'): Pose {
	if (pointer === null) {
		return {...FACING};
	}
	const bounds = canvas.getBoundingClientRect();
	if (tracking === 'head') {
		return poseTowardPointer(pointer, bounds);
	}
	return poseTowardPointer(pointer, bounds, {
		width: window.innerWidth,
		height: window.innerHeight,
	});
}

/**
 * A head that looks at the cursor while `watching`: facing you, turning toward the pointer
 * wherever it goes on the page, and blinking every few seconds; once it stops watching, it settles
 * back to rest. Clicked, it blinks, watching or not. Either way it is drawn only while it has
 * somewhere to go or is blinking: once it is where it should look, it stays, drawn no more until
 * the pointer moves, it is to look elsewhere, or it blinks.
 */
export function LiveHead({
	look,
	color,
	size,
	watching = true,
	tracking = 'viewport',
	recallPose,
	rememberPose,
	className,
}: {
	look: Look;
	color: string;
	size: number;
	watching?: boolean;
	tracking?: 'head' | 'viewport';
	recallPose?: () => Pose | null;
	rememberPose?: (pose: Pose) => void;
	className?: string;
}) {
	const ref = useRef<HTMLCanvasElement>(null);
	// The look, color and whether to watch as they are now, read each frame, so a change shows
	// without restarting; and the loop, to set going again once it has settled: as these change,
	// and as the pointer moves.
	const spec = useRef({look, color});
	const watch = useRef(watching);
	const trackingMode = useRef(tracking);
	const memory = useRef({recallPose, rememberPose});
	const firstHoverUntil = useRef(0);
	// When the blink under way started; none between blinks.
	const blinkStart = useRef<number | null>(null);
	const wake = useRef<(() => void) | null>(null);
	const blink = useCallback(() => {
		blinkStart.current = performance.now();
		wake.current?.();
	}, []);
	const wakeFromPointer = useCallback(() => {
		if (!watch.current) {
			return;
		}
		wake.current?.();
	}, []);
	const redraws = useSyncExternalStore(subscribeRedraw, redrawVersion);
	useEffect(() => {
		memory.current = {recallPose, rememberPose};
	}, [recallPose, rememberPose]);
	// Blinks now and then, while it follows the cursor.
	useEffect(() => {
		if (!watching) {
			return;
		}
		let timer = 0;
		const plan = () => {
			timer = window.setTimeout(() => {
				blink();
				plan();
			}, nextBlinkDelay());
		};
		plan();
		return () => window.clearTimeout(timer);
	}, [watching, blink]);
	// Drawn again with the page's theme as it is now.
	useEffect(() => {
		wake.current?.();
	}, [redraws]);
	useEffect(() => {
		if (!watch.current && watching) {
			firstHoverUntil.current = performance.now() + FIRST_HOVER_DURATION_MS;
		}
		if (!watching) {
			firstHoverUntil.current = 0;
		}
		spec.current = {look, color};
		watch.current = watching;
		trackingMode.current = tracking;
		if (watching) {
			wakers.add(wakeFromPointer);
		}
		if (!watching) {
			wakers.delete(wakeFromPointer);
		}
		wake.current?.();
	}, [look, color, tracking, wakeFromPointer, watching]);
	useEffect(() => {
		const canvas = ref.current;
		if (!canvas) {
			return;
		}
		let current = true;
		let running = false;
		let frame = 0;
		let lastFrame = performance.now();
		// Starts looking at the pointer, or at rest, then eases toward where it should look.
		const pose =
			memory.current.recallPose?.() ??
			(watch.current ? toward(canvas, trackingMode.current) : {...REST});
		void loadStage().then((stage) => {
			if (!current || !stage) {
				return;
			}
			const tick = () => {
				if (!current) {
					return;
				}
				const now = performance.now();
				const elapsed = Math.min(now - lastFrame, 50);
				lastFrame = now;
				const target = watch.current ? toward(canvas, trackingMode.current) : REST;
				const settled =
					Math.abs(target.rotX - pose.rotX) < 0.05 &&
					Math.abs(target.rotY - pose.rotY) < 0.05 &&
					Math.abs(target.rotZ - pose.rotZ) < 0.05;
				if (settled) {
					Object.assign(pose, target);
				}
				if (!settled) {
					const amount = followAmount(
						elapsed,
						followTime(watch.current, now, firstHoverUntil.current),
					);
					pose.rotX += (target.rotX - pose.rotX) * amount;
					pose.rotY += (target.rotY - pose.rotY) * amount;
					pose.rotZ += (target.rotZ - pose.rotZ) * amount;
				}
				const blinking = blinkStart.current !== null && now - blinkStart.current < BLINK_MS;
				const closed = blinkAmount(now, blinkStart.current);
				if (!blinking) {
					blinkStart.current = null;
				}
				memory.current.rememberPose?.({...pose});
				paintHead(
					stage,
					canvas,
					spec.current,
					pose,
					pixels(size),
					watch.current || !settled || blinking,
					closed,
				);
				if (settled && !blinking) {
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
				lastFrame = performance.now();
				frame = requestAnimationFrame(tick);
			};
			if (watch.current) {
				wakers.add(wakeFromPointer);
			}
			wake.current();
		});
		return () => {
			current = false;
			wakers.delete(wakeFromPointer);
			wake.current = null;
			cancelAnimationFrame(frame);
		};
	}, [size, wakeFromPointer]);
	return (
		<canvas
			ref={ref}
			aria-hidden
			data-slot="live-head"
			data-state={watching ? 'watching' : 'rest'}
			onClick={blink}
			className={cn('shrink-0', className)}
			style={{width: size, height: size}}
		/>
	);
}
