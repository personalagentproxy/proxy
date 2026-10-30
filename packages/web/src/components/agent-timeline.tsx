import type {ActivityTimeline as ActivityAnswer, AuditEntry} from '@proxy/contracts/activity';
import type {AgentLogin} from '@proxy/contracts/agents';
import type {Connection} from '@proxy/contracts/connections';
import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {useLocation, useSearchParams} from 'react-router';
import {getActivityTimeline} from '@/client/agents-client';
import {AuditEntryDialog} from '@/components/audit-entry-dialog';
import {ActivityTimeline, CHART_ATTRIBUTE} from '@/components/activity-timeline';
import type {Window} from '@/lib/activity-timeline';
import {useOrgSlug} from '@/hooks/use-org';
import {
	DEFAULT_MINUTES,
	endsOf,
	LOADED_MINUTES,
	MAX_MINUTES,
	MIN_MINUTES,
	presetOf,
	windowLabel,
	WINDOWS,
	windowStart,
	zoomed,
	zoomedOn,
} from '@/lib/timeline-window';
import {zoomPath} from '@/lib/zoom-path';
import {Button} from '@proxy/ui/components/button';
import {cn} from '@proxy/ui/lib/utils';
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@proxy/ui/components/select';

// How often the timeline is read again while the page is open, so a task under way moves along.
const REFRESH_MS = 60 * 1000;

// Zooming or scrolling with the wheel is told to the api this long after the last turn.
const ZOOM_SETTLE_MS = 300;

const MINUTE_MS = 60 * 1000;

const CUSTOM = 'custom';

// How long zooming in on a bar of several tasks takes: as long as a row takes to grow or shrink
// (activity-timeline.tsx), so the rows making room for what the zoom brings move with it.
const ZOOM_MS = 300;

// How many windows along the way of a zoom the chart is shown ahead of time, so its rows make room
// for every one of them as the zoom sets off.
const AHEAD_STEPS = 12;
const NO_WINDOWS: Window[] = [];

function easeInOut(progress: number): number {
	return progress < 0.5 ? 2 * progress * progress : 1 - (-2 * progress + 2) ** 2 / 2;
}

function cancelZoom(zooming: {current: number | null}) {
	if (zooming.current !== null) {
		cancelAnimationFrame(zooming.current);
		zooming.current = null;
	}
}

// Under the home page's input: who is doing what for the person. Every agent's row over the tasks
// it was given in a window of time, up to now at the right edge, each with the requests made for
// it; a task's bar opens its page, and a request opens in full. The window's
// length is chosen above the timeline, or zoomed with Ctrl or Cmd and the wheel, or a pinch, as a
// video editor's timeline is, around the moment under the pointer; zoomed to a length not on offer,
// the choice reads Custom. Scrolling sideways, or with Shift, moves it back in time and forward again
// up to now, where it follows now once more; Now brings it straight back. A bar of several short
// tasks zooms the window in on them. The timeline is read
// again every minute, at least a day back, or the window's own stretch where it is scrolled back
// further than that. With no task in the past day, there is nothing to show, and it stays off the
// page.
export function AgentTimeline({
	initial,
	agents,
	connections,
}: {
	initial: ActivityAnswer;
	agents: AgentLogin[];
	connections: Connection[];
}) {
	const org = useOrgSlug();
	// The window is kept in the address, so coming back to the page, by the browser's back button
	// or a task page's, finds it as it was.
	const [params, setParams] = useSearchParams();
	const location = useLocation();
	const [minutes, setMinutes] = useState(() => windowFromParams(params).minutes);
	// The answer shown: the first came with the page. Zoomed out past what it covers, the older
	// part arrives with the next reading; zoomed in, it has everything already.
	const [answer, setAnswer] = useState(initial);
	const [opened, setOpened] = useState<AuditEntry | null>(null);
	// Where the window ends, scrolled back in time; null while it ends at now.
	const [end, setEnd] = useState<number | null>(() => windowFromParams(params).end);
	const mounted = useRef(false);
	// The window's length and end, and the now it is drawn up to, for the wheel's listener, which is
	// added once. The listener moves them itself, as several turns of the wheel may come before the
	// page is drawn again.
	const length = useRef(minutes);
	const ending = useRef(end);
	const latest = useRef(Date.parse(initial.now));
	useEffect(() => {
		length.current = minutes;
		ending.current = end;
	}, [minutes, end]);
	useEffect(() => {
		latest.current = Date.parse(answer.now);
	}, [answer.now]);

	useEffect(() => {
		let gone = false;
		const read = async () => {
			const range = loadedRange(minutes, end, Date.now());
			const result = await getActivityTimeline(
				org,
				new Date(range.from).toISOString(),
				range.to === null ? undefined : new Date(range.to).toISOString(),
			);
			if (gone || result.isErr()) {
				return;
			}
			setAnswer(result.value);
		};
		// The page's own answer is fresh; a window chosen after it is read once it settles.
		// Opened on a window that reaches further back than the page's own answer, it is read at once.
		const beyond =
			(end ?? Date.now()) - minutes * MINUTE_MS < Date.now() - LOADED_MINUTES * MINUTE_MS;
		const settle = mounted.current || beyond ? setTimeout(() => void read(), ZOOM_SETTLE_MS) : null;
		mounted.current = true;
		const timer = setInterval(() => {
			if (document.visibilityState === 'visible') {
				void read();
			}
		}, REFRESH_MS);
		return () => {
			gone = true;
			if (settle !== null) {
				clearTimeout(settle);
			}
			clearInterval(timer);
		};
	}, [org, minutes, end]);

	// A zoom under way on a bar of several tasks (zoomTo), to stop for the wheel or on leaving; and
	// the windows it will pass through, for the chart to make room for.
	const zooming = useRef<number | null>(null);
	const [ahead, setAhead] = useState<Window[]>(NO_WINDOWS);
	useEffect(() => () => cancelZoom(zooming), []);

	// The wheel with Ctrl or Cmd held, which a pinch on a trackpad also sends, zooms rather than
	// scrolls the page, and sideways, or with Shift, scrolls the timeline through time, as far as the
	// pointer moved; listened to by hand, since React's wheel listener can't stop the scroll. Up and
	// down, the page scrolls as ever, and a zoom under way goes on. On the timeline whenever it is
	// there, which it isn't while there is nothing to show. Now is the timeline's, as it was last
	// read, so the window moves where it is drawn.
	const listenForZoom = useCallback((element: HTMLDivElement) => {
		// Zoomed with the wheel, the window is whole minutes again once the wheel rests.
		let rest: ReturnType<typeof setTimeout> | undefined;
		const rounded = () => {
			const whole = Math.round(length.current);
			if (whole === length.current || zooming.current !== null) {
				return;
			}
			length.current = whole;
			setMinutes(whole);
		};
		// The chart beside the agents' names, measured as the wheel turns, since where it starts and
		// how wide it is change with the screen: where the pointer is over it, and how long a pixel is.
		const chartBox = () => {
			const chart = element.querySelector(`[${CHART_ATTRIBUTE}]`) ?? element;
			const box = chart.getBoundingClientRect();
			return {left: box.left, width: Math.max(box.width, 100)};
		};
		const move = (nextMinutes: number, nextEnd: number | null) => {
			cancelZoom(zooming);
			setAhead(NO_WINDOWS);
			length.current = nextMinutes;
			ending.current = nextEnd;
			setMinutes(nextMinutes);
			setEnd(nextEnd);
		};
		const onWheel = (event: WheelEvent) => {
			const now = latest.current;
			if (event.ctrlKey || event.metaKey) {
				event.preventDefault();
				// The moment under the pointer stays where it is, the window growing or shrinking
				// around it; up to now, past which the window can't reach.
				const current = length.current;
				const next = zoomed(current, event.deltaY);
				const chart = chartBox();
				const fraction = Math.min(Math.max((event.clientX - chart.left) / chart.width, 0), 1);
				const endAt = ending.current ?? now;
				const under = endAt - (1 - fraction) * current * MINUTE_MS;
				const nextEnd = under + (1 - fraction) * next * MINUTE_MS;
				move(
					next,
					nextEnd >= now ? null : Math.max(nextEnd, now - (MAX_MINUTES - next) * MINUTE_MS),
				);
				clearTimeout(rest);
				rest = setTimeout(rounded, ZOOM_SETTLE_MS);
				return;
			}
			const sideways = event.shiftKey ? event.deltaY : event.deltaX;
			if (!event.shiftKey && Math.abs(event.deltaX) <= Math.abs(event.deltaY)) {
				return;
			}
			event.preventDefault();
			// A zoom stopped part of the way is whole minutes again.
			const current = zooming.current === null ? length.current : Math.round(length.current);
			const msPerPx = (current * MINUTE_MS) / chartBox().width;
			const next = (ending.current ?? now) + sideways * msPerPx;
			move(current, next >= now ? null : Math.max(next, now - (MAX_MINUTES - current) * MINUTE_MS));
		};
		element.addEventListener('wheel', onWheel, {passive: false});
		return () => {
			clearTimeout(rest);
			element.removeEventListener('wheel', onWheel);
		};
	}, []);

	// Choosing a window, or going back to now, stops a zoom under way, which would otherwise carry
	// the window on to where it was headed.
	const stopZoom = () => {
		cancelZoom(zooming);
		setAhead(NO_WINDOWS);
	};

	// The window zoomed in on a stretch of time: a little longer than it, centred on it, ending at
	// now where the stretch runs up to it. It gets there over a moment rather than at once, along
	// the path maps fly along (lib/zoom-path.ts), pan and zoom as one motion at one even pace; the
	// window is whatever length the path gives it on the way, whole minutes again once there. The
	// chart is told the windows along the way as the zoom sets off, so its rows make room for all
	// of them at once, moving with the zoom rather than as each comes. At once for those who would
	// rather not see motion.
	const zoomTo = (from: number, to: number) => {
		const now = latest.current;
		const least = MIN_MINUTES * MINUTE_MS;
		const most = MAX_MINUTES * MINUTE_MS;
		const padded = zoomedOn(from, to);
		const middle = (from + to) / 2;
		const startWidth = minutes * MINUTE_MS;
		const startEnd = Math.min(end ?? now, now);
		const targetEnd = Math.min(middle + padded / 2, now);
		const path = zoomPath(
			{center: startEnd - startWidth / 2, width: startWidth},
			{center: targetEnd - padded / 2, width: padded},
		);
		const windowAt = (t: number): Window => {
			const view = path(t);
			const width = Math.min(Math.max(view.width, least), most);
			const to = Math.min(view.center + width / 2, now);
			return {from: new Date(to - width), to: new Date(to)};
		};
		const show = (t: number, there: boolean) => {
			const view = path(t);
			const width = Math.min(Math.max(view.width, least), most);
			const endAt = view.center + width / 2;
			setMinutes(there ? Math.round(width / MINUTE_MS) : width / MINUTE_MS);
			setEnd(endAt >= now ? null : endAt);
		};
		cancelZoom(zooming);
		if (globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
			show(1, true);
			return;
		}
		setAhead(Array.from({length: AHEAD_STEPS + 1}, (_, index) => windowAt(index / AHEAD_STEPS)));
		const began = performance.now();
		const step = (time: number) => {
			const progress = Math.min((time - began) / ZOOM_MS, 1);
			if (progress >= 1) {
				zooming.current = null;
				setAhead(NO_WINDOWS);
				show(1, true);
				return;
			}
			show(easeInOut(progress), false);
			zooming.current = requestAnimationFrame(step);
		};
		zooming.current = requestAnimationFrame(step);
	};

	// Once the window settles, it is written to the address, in place of the entry there, so the
	// page is found as it was on coming back; the default window leaves the address clean. Only
	// where it changed: writing the address as it is would read the whole page again (router.tsx).
	useEffect(() => {
		const timer = setTimeout(() => {
			const next = new URLSearchParams(location.search);
			next.delete('window');
			next.delete('end');
			if (Math.round(minutes) !== DEFAULT_MINUTES) {
				next.set('window', String(Math.round(minutes)));
			}
			if (end !== null) {
				next.set('end', String(Math.round(end)));
			}
			if (next.toString() === new URLSearchParams(location.search).toString()) {
				return;
			}
			setParams(next, {replace: true});
		}, ZOOM_SETTLE_MS);
		return () => clearTimeout(timer);
	}, [minutes, end, location.search, setParams]);
	// The window's length as read: whole minutes, which it is but for a moment while zooming in.
	const wholeMinutes = Math.round(minutes);
	// Where a task's page comes back to: this page, with the window as it is now.
	const backTo = `${location.pathname}${windowSearch(wholeMinutes, end)}`;

	// Scrolled or zoomed to where there is nothing, the timeline stays up, its rows going the way
	// they do, and only says so once the window has rested a second.
	const resting = useRested(`${minutes}:${end ?? ''}`);

	// When each task ended, or now while it is under way, worked out once for every window.
	const endsAt = useMemo(() => {
		const now = new Date(answer.now);
		const ends = endsOf(answer.tasks, answer.entries, now);
		return new Map(answer.tasks.map((task) => [task.id, (ends.get(task.id) ?? now).getTime()]));
	}, [answer]);

	// Nothing in the past day, or further back where the window reaches: nothing to show at all.
	// Scrolled back further than a day, what was read is the window's own stretch, which may be empty.
	if (answer.tasks.length === 0 && answer.to === answer.now) {
		return null;
	}

	const now = new Date(answer.now);
	const to = end === null ? now : new Date(Math.min(end, now.getTime()));
	const window = {from: windowStart(minutes, to), to};
	// A task is in the window where it started before the window ends and ended after it begins.
	const inWindow = answer.tasks.some((task) => {
		if (new Date(task.startedAt).getTime() > window.to.getTime()) {
			return false;
		}
		return (endsAt.get(task.id) ?? now.getTime()) >= window.from.getTime();
	});
	const preset = presetOf(wholeMinutes);

	return (
		<section aria-label="Agents" className="flex w-full max-w-3xl flex-col items-end gap-2 text-sm">
			<div className="flex items-center gap-2">
				{/* Always there, fading in and out, so nothing else moves when it comes and goes. */}
				<Button
					variant="outline"
					size="sm"
					onClick={() => {
						stopZoom();
						setEnd(null);
					}}
					aria-hidden={end === null}
					tabIndex={end === null ? -1 : undefined}
					className={cn(
						'transition-opacity duration-300 motion-reduce:transition-none',
						end === null && 'pointer-events-none opacity-0',
					)}
				>
					Now
				</Button>
				<Select
					value={preset ?? CUSTOM}
					// What the closed select reads: "Last 6 hours" while the window ends at now, "6 hours"
					// scrolled back from it. The choices themselves always read "Last".
					items={[
						...WINDOWS.map((choice) => ({
							value: choice.id,
							label: windowLabel(choice.minutes, end === null),
						})),
						{value: CUSTOM, label: windowLabel(wholeMinutes, end === null)},
					]}
					onValueChange={(next) => {
						const chosen = WINDOWS.find((choice) => choice.id === next);
						if (chosen) {
							stopZoom();
							setMinutes(chosen.minutes);
						}
					}}
				>
					<SelectTrigger size="sm" aria-label="Window" className="w-36">
						<SelectValue />
					</SelectTrigger>
					<SelectContent alignItemWithTrigger={false}>
						{WINDOWS.map((choice) => (
							<SelectItem key={choice.id} value={choice.id}>
								{choice.label}
							</SelectItem>
						))}
						{preset === null && <SelectItem value={CUSTOM}>Custom</SelectItem>}
					</SelectContent>
				</Select>
			</div>
			<div ref={listenForZoom} className="w-full">
				{(inWindow || !resting) && (
					<ActivityTimeline
						tasks={answer.tasks}
						entries={answer.entries}
						now={answer.now}
						window={window}
						agents={agents}
						connections={connections}
						onOpenEntry={setOpened}
						onZoom={zoomTo}
						ahead={ahead}
						backTo={backTo}
					/>
				)}
				{!inWindow && resting && (
					<p className="rounded-lg border px-4 py-3 text-center text-muted-foreground">
						{end === null
							? `No tasks in the ${windowLabel(wholeMinutes).toLowerCase()}.`
							: 'No tasks in this stretch of time.'}
					</p>
				)}
			</div>
			<AuditEntryDialog
				entry={opened}
				agents={agents}
				connections={connections}
				tasks={answer.tasks}
				onClose={() => setOpened(null)}
			/>
		</section>
	);
}

// How long the window has to stay put before it has come to rest.
const REST_MS = 1000;

/** Whether the window, told apart by `key`, has stayed the same for a second. */
function useRested(key: string): boolean {
	const [seen, setSeen] = useState(key);
	const [rested, setRested] = useState(true);
	if (key !== seen) {
		setSeen(key);
		setRested(false);
	}
	useEffect(() => {
		const timer = setTimeout(() => setRested(true), REST_MS);
		return () => clearTimeout(timer);
	}, [key]);
	return rested;
}

// What is read for a window, in milliseconds since the epoch: from its start, and at least a day
// back, up to now; or, scrolled back further than a day, its own stretch alone (`to` null for now).
function loadedRange(
	minutes: number,
	end: number | null,
	now: number,
): {from: number; to: number | null} {
	const dayAgo = now - LOADED_MINUTES * MINUTE_MS;
	const windowEnd = end ?? now;
	const windowFrom = windowEnd - minutes * MINUTE_MS;
	if (windowEnd < dayAgo) {
		return {from: windowFrom, to: windowEnd};
	}
	return {from: Math.min(windowFrom, dayAgo), to: null};
}

// The window as the address has it: its length in minutes and where it ends, where either is
// there and makes sense; else the default, ending at now.
function windowFromParams(params: URLSearchParams): {minutes: number; end: number | null} {
	const minutes = Number(params.get('window'));
	const end = Number(params.get('end'));
	return {
		minutes:
			Number.isInteger(minutes) && minutes >= MIN_MINUTES && minutes <= MAX_MINUTES
				? minutes
				: DEFAULT_MINUTES,
		end: Number.isFinite(end) && end > 0 && end < Date.now() ? end : null,
	};
}

// The search part of the address for a window: empty for the default, ending at now.
function windowSearch(minutes: number, end: number | null): string {
	const params = new URLSearchParams();
	if (minutes !== DEFAULT_MINUTES) {
		params.set('window', String(minutes));
	}
	if (end !== null) {
		params.set('end', String(Math.round(end)));
	}
	const search = params.toString();
	return search ? `?${search}` : '';
}
