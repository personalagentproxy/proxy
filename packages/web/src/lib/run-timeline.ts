import type {ActivityTask, AuditEntry} from '@proxy/contracts/activity';
import {
	formatDuration,
	layRequests,
	merged,
	requestTimes,
	SECOND,
	type Span,
	stepFor,
	type TimelineRequest,
} from '@/lib/timeline';
import {combinedStatus, endsOf, type TaskStatus, taskStatus} from '@/lib/timeline-window';

// A task's run on its page: how it went, as a tree of tasks over time. Agents work through
// sub-agents, and each task is one of them at work, so the task has a row at the top and every
// task handed on from it, at any depth, a row of its own under the task it was handed from,
// indented a step further. The axis runs from when the task started to the last thing done, or to
// now while a task is still under way, in pixels: stretches of it where nothing happened, no
// request in flight and no task starting or finishing, are folded to a narrow break, so the busy
// minutes of a day-long run take the width and its idle hours don't. A row's track runs as long as
// its task did; on it, every request made for the task, as long as each took, and hatching where
// the task waited on what it handed on. Short tasks handed on one after another are grouped into
// one row, since a row each would hold nothing readable. Nothing here is what the agent thought or
// said, only what Personal Agent Proxy saw: the tasks, and the requests.

export type RunRow = {
	kind: 'task' | 'group';
	// The task's id, or, for a group, `group:` and its first member's.
	id: string;
	// How far down the tree it is: 0 for a task the agent started itself.
	depth: number;
	// The row of the task it was handed from; null at the top.
	parentRow: number | null;
	// The task, or the group's members, in the order started.
	tasks: ActivityTask[];
	// The task's, or, for a group, under way if any member is, else left open if every member was.
	status: TaskStatus;
	// Where its track runs, in pixels from the chart's left edge.
	start: number;
	end: number;
	// Where each member runs; the task itself for a task row.
	members: Span[];
	// From when it started to when it ended, or to now.
	durationMs: number;
	// The requests made for it, and for every task rolled into it.
	requests: TimelineRequest[];
	// Where the tasks laid out under it were under way.
	waiting: Span[];
	// How many tasks are rolled into it: those handed on from it at any depth, or, for a group, its
	// members and theirs.
	rolledIn: number;
	// It was finished by its agent saying so, rather than along with the task it was handed from:
	// a line runs back up to that task where it was.
	handedBack: boolean;
};

// An idle stretch folded to a break in the axis, and how long it was.
export type RunBreak = Span & {idleMs: number};

type RunTick = {px: number; label: string};

export type RunTimeline = {
	rows: RunRow[];
	width: number;
	spanMs: number;
	ticks: RunTick[];
	breaks: RunBreak[];
};

// The least the axis is, so a run done in a moment still has room to show its requests.
const MIN_SPAN_MS = 10 * SECOND;

// How wide a break is drawn, and the least an idle stretch would take unfolded before it is
// folded: folding it has to free a good deal more than the break takes.
export const BREAK_PX = 28;
const MIN_IDLE_PX = 120;

// How far the busy stretch on either side of a break runs on past the last thing in it, so a
// request never ends right at a break's edge; and the least two breaks are apart, so their labels
// don't run into each other.
const BREAK_PAD_PX = 8;
const MIN_BETWEEN_PX = 56;

// The least a busy stretch is taken to last, deciding what to fold (buildAxis).
const MIN_BUSY_MS = SECOND;

// The room an axis label takes, "23h 30m" with space around it.
const LABEL_PX = 72;

// A task drawn narrower than this is short; short tasks handed on one after another, less than
// the gap apart, are grouped into one row.
const SHORT_PX = 28;
const GROUP_GAP_PX = 20;

type Axis = {
	// Pixels from the chart's left edge for a time since the run started.
	px: (ms: number) => number;
	breaks: RunBreak[];
	ticks: RunTick[];
};

/**
 * The run's axis, `width` pixels for `spanMs` of time: linear, but for the stretches between
 * `busy` stretches (in milliseconds since the run started) that would take more than a little of
 * the width while nothing happened in them, each folded to a break.
 */
export function buildAxis(spanMs: number, busy: Span[], width: number): Axis {
	// Each busy stretch is taken as at least a second long: a task starting or a request that took
	// no time is a moment, and with only moments left unfolded, the few milliseconds between two of
	// them would take the whole width.
	const lasting = busy.map((span) => ({
		start: span.start,
		end: Math.max(span.end, span.start + MIN_BUSY_MS),
	}));
	const active = merged(lasting).map((span) => ({
		start: Math.max(0, span.start),
		end: Math.min(spanMs, span.end),
	}));
	const gaps = active
		.slice(1)
		.map((span, index) => ({start: active[index]?.end ?? 0, end: span.start}))
		.filter((gap) => gap.end > gap.start);
	// The longest idle stretches are folded first, each while it would still take more than its
	// share of the width at the scale the folds so far leave; folding one leaves more width to
	// the rest, so the pass is made again until nothing more folds.
	const byLength = [...gaps].sort((a, b) => b.end - b.start - (a.end - a.start));
	const folded = new Set<Span>();
	const scale = () => {
		const foldedMs = [...folded].reduce((total, gap) => total + gap.end - gap.start, 0);
		return (width - folded.size * BREAK_PX) / Math.max(spanMs - foldedMs, 1);
	};
	let more = true;
	while (more) {
		more = false;
		for (const gap of byLength) {
			if (folded.has(gap)) {
				continue;
			}
			if ((gap.end - gap.start) * scale() > MIN_IDLE_PX) {
				folded.add(gap);
				more = true;
			}
		}
	}
	// Two breaks with next to nothing between them would run into each other: the shorter unfolds.
	let crowded = true;
	while (crowded) {
		crowded = false;
		const sorted = [...folded].sort((a, b) => a.start - b.start);
		for (let index = 0; index + 1 < sorted.length; index += 1) {
			const left = sorted[index];
			const right = sorted[index + 1];
			if (!left || !right || (right.start - left.end) * scale() >= MIN_BETWEEN_PX) {
				continue;
			}
			folded.delete(left.end - left.start < right.end - right.start ? left : right);
			crowded = true;
			break;
		}
	}
	// Each fold keeps a little of its stretch on either side, so what ends at its edge has room.
	const pad = BREAK_PAD_PX / scale();
	const breaks = [...folded]
		.map((gap) => ({start: gap.start + pad, end: gap.end - pad}))
		.filter((gap) => gap.end > gap.start)
		.sort((a, b) => a.start - b.start);
	const pxPerMs =
		(width - breaks.length * BREAK_PX) /
		Math.max(spanMs - breaks.reduce((total, gap) => total + gap.end - gap.start, 0), 1);
	// Where the scale changes: at each break's edges, and at either end of the axis.
	const knots: Array<{ms: number; px: number}> = [{ms: 0, px: 0}];
	for (const gap of breaks) {
		const last = knots[knots.length - 1] ?? {ms: 0, px: 0};
		const at = last.px + (gap.start - last.ms) * pxPerMs;
		knots.push({ms: gap.start, px: at}, {ms: gap.end, px: at + BREAK_PX});
	}
	knots.push({ms: spanMs, px: width});
	const px = (ms: number) => {
		const at = Math.min(Math.max(ms, 0), spanMs);
		const index = knots.findIndex((knot) => knot.ms >= at);
		const to = knots[Math.max(index, 1)] ?? {ms: spanMs, px: width};
		const from = knots[Math.max(index, 1) - 1] ?? {ms: 0, px: 0};
		if (to.ms === from.ms) {
			return to.px;
		}
		return from.px + ((at - from.ms) / (to.ms - from.ms)) * (to.px - from.px);
	};
	return {
		px,
		breaks: breaks.map((gap) => ({
			start: px(gap.start),
			end: px(gap.end),
			idleMs: gap.end - gap.start,
		})),
		ticks: axisTicks(knots, width),
	};
}

// Where the axis is marked: in each stretch between breaks, a round step apart, as many as there
// is room to label, none where a break's own label goes, from "0s" at the start.
function axisTicks(knots: Array<{ms: number; px: number}>, width: number): RunTick[] {
	const ticks: RunTick[] = [];
	for (let index = 0; index + 1 < knots.length; index += 2) {
		const from = knots[index];
		const to = knots[index + 1];
		if (!from || !to || to.ms <= from.ms) {
			continue;
		}
		const step = stepFor(to.ms - from.ms, to.px - from.px, LABEL_PX);
		const afterBreak = index > 0;
		const beforeBreak = index + 2 < knots.length;
		for (let ms = Math.ceil(from.ms / step) * step; ms <= to.ms; ms += step) {
			const px = from.px + ((ms - from.ms) / (to.ms - from.ms)) * (to.px - from.px);
			if (afterBreak && px < from.px + LABEL_PX * 0.8) {
				continue;
			}
			if (beforeBreak && px > to.px - LABEL_PX * 0.8) {
				continue;
			}
			ticks.push({px: Math.min(px, width), label: ms === 0 ? '0s' : formatDuration(ms)});
		}
	}
	return ticks;
}

/**
 * Which tasks' sub-tasks are laid out under them at first: those at the top, the page's own task,
 * so what it handed on shows. Every other task's are rolled into it.
 */
export function defaultExpanded(tasks: ActivityTask[]): Set<string> {
	const ids = new Set(tasks.map((task) => task.id));
	return new Set(
		tasks
			.filter((task) => task.parentId === null || !ids.has(task.parentId))
			.map((task) => task.id),
	);
}

/**
 * The timeline of a run, `width` pixels wide, as it stood at `now`: every task in a row under the
 * task it was handed from, those in `expanded` with their sub-tasks laid out under them and every
 * other's rolled in, short tasks one after another grouped.
 */
export function buildRunTimeline(
	tasks: ActivityTask[],
	entries: AuditEntry[],
	now: Date,
	width: number,
	{expanded = new Set()}: {expanded?: ReadonlySet<string>} = {},
): RunTimeline {
	const time = (iso: string) => new Date(iso).getTime();
	if (tasks.length === 0) {
		const axis = buildAxis(MIN_SPAN_MS, [], width);
		return {rows: [], width, spanMs: MIN_SPAN_MS, ticks: axis.ticks, breaks: axis.breaks};
	}
	const byId = new Map(tasks.map((task) => [task.id, task]));
	const ofTask = new Map<string, AuditEntry[]>();
	for (const entry of entries) {
		if (entry.taskId === null || !byId.has(entry.taskId)) {
			continue;
		}
		const own = ofTask.get(entry.taskId);
		if (own) {
			own.push(entry);
			continue;
		}
		ofTask.set(entry.taskId, [entry]);
	}
	const ends = endsOf(tasks, entries, now);
	const endOf = (task: ActivityTask) => (ends.get(task.id) ?? now).getTime();
	const origin = Math.min(...tasks.map((task) => time(task.startedAt)));
	const running = tasks.some((task) => taskStatus(task, now) === 'running');
	const lastActive = Math.max(
		...tasks.map((task) => time(task.finishedAt ?? task.startedAt)),
		...tasks.map(endOf),
		...entries.map((entry) => time(entry.at)),
	);
	const spanMs = Math.max((running ? now.getTime() : lastActive) - origin, MIN_SPAN_MS);
	const axisEnd = origin + spanMs;
	// When anything happened: a request in flight, a task starting or ending, and now while a task
	// is under way. The axis folds what lies between.
	const busy: Span[] = [
		...entries.flatMap((entry) => {
			const ran = requestTimes(entry);
			return entry.taskId !== null && byId.has(entry.taskId)
				? [{start: ran.from - origin, end: ran.to - origin}]
				: [];
		}),
		...tasks.flatMap((task) => [
			{start: time(task.startedAt) - origin, end: time(task.startedAt) - origin},
			...(endOf(task) <= axisEnd ? [{start: endOf(task) - origin, end: endOf(task) - origin}] : []),
		]),
		...(running ? [{start: spanMs, end: spanMs}] : []),
	];
	const axis = buildAxis(spanMs, busy, width);
	const px = (ms: number) => axis.px(ms - origin);

	const parentOf = (task: ActivityTask) =>
		task.parentId !== null && byId.has(task.parentId) ? task.parentId : null;
	// The tasks handed on from each, in the order started, under null those at the top; and every
	// task under each at any depth, worked out once.
	const children = new Map<string | null, ActivityTask[]>();
	for (const task of [...tasks].sort(
		(a, b) => time(a.startedAt) - time(b.startedAt) || a.id.localeCompare(b.id),
	)) {
		const parentId = parentOf(task);
		const siblings = children.get(parentId);
		if (siblings) {
			siblings.push(task);
			continue;
		}
		children.set(parentId, [task]);
	}
	const below = (parentId: string | null) => children.get(parentId) ?? [];
	const under = new Map<string, ActivityTask[]>();
	const descendants = (task: ActivityTask): ActivityTask[] => {
		const known = under.get(task.id);
		if (known) {
			return known;
		}
		const found = below(task.id).flatMap((child) => [child, ...descendants(child)]);
		under.set(task.id, found);
		return found;
	};
	const requestsOf = (of: ActivityTask[]) =>
		layRequests(
			of.flatMap((task) => ofTask.get(task.id) ?? []),
			px,
			origin,
			axisEnd,
		);
	const spanOf = (task: ActivityTask): Span => ({
		start: px(time(task.startedAt)),
		end: px(Math.min(endOf(task), axisEnd)),
	});
	const finishedWithParent = (task: ActivityTask) => {
		const parentId = parentOf(task);
		const parent = parentId === null ? undefined : byId.get(parentId);
		return (
			task.finishedAt !== null &&
			task.outcome === null &&
			parent !== undefined &&
			task.finishedAt === parent.finishedAt
		);
	};
	// Every one of them finished, and one or more by its agent saying so: one left open was
	// handed back to nothing.
	const handedBack = (of: ActivityTask[]) =>
		of.every((task) => taskStatus(task, now) === 'finished') &&
		of.some((task) => !finishedWithParent(task));

	const rows: RunRow[] = [];
	const lay = (children: ActivityTask[], depth: number, parentRow: number | null): Span[] => {
		const laid: Span[] = [];
		for (const item of grouped(children, spanOf)) {
			if (item.length > 1 && !expanded.has(groupId(item))) {
				const rolled = item.flatMap((task) => [task, ...descendants(task)]);
				const members = item.map(spanOf);
				const first = Math.min(...item.map((task) => time(task.startedAt)));
				const last = Math.max(...item.map((task) => Math.min(endOf(task), axisEnd)));
				const status = combinedStatus(item.map((task) => taskStatus(task, now)));
				rows.push({
					kind: 'group',
					id: groupId(item),
					depth,
					parentRow,
					tasks: item,
					status,
					start: Math.min(...members.map((span) => span.start)),
					end: Math.max(...members.map((span) => span.end)),
					members,
					durationMs: last - first,
					requests: requestsOf(rolled),
					waiting: [],
					rolledIn: rolled.length,
					handedBack: handedBack(item),
				});
				laid.push({start: px(first), end: px(last)});
				continue;
			}
			for (const task of item) {
				const span = spanOf(task);
				const handedOn = descendants(task);
				const open = expanded.has(task.id) && handedOn.length > 0;
				const row: RunRow = {
					kind: 'task',
					id: task.id,
					depth,
					parentRow,
					tasks: [task],
					status: taskStatus(task, now),
					start: span.start,
					end: span.end,
					members: [span],
					durationMs: Math.min(endOf(task), axisEnd) - time(task.startedAt),
					requests: requestsOf(open ? [task] : [task, ...handedOn]),
					waiting: [],
					rolledIn: open ? 0 : handedOn.length,
					handedBack: handedBack([task]),
				};
				const index = rows.push(row) - 1;
				if (open) {
					row.waiting = merged(lay(below(task.id), depth + 1, index)).filter(
						(stretch) => stretch.end > stretch.start,
					);
				}
				laid.push(span);
			}
		}
		return laid;
	};
	lay(below(null), 0, null);
	return {rows, width, spanMs, ticks: axis.ticks, breaks: axis.breaks};
}

/**
 * `expanded` with the task `taskId` folded: what it handed on rolled back into it, and every group
 * of tasks under it, at any depth, together again. A group laid out is no row of its own, so it is
 * found by its first member, one of the tasks under the one folded.
 */
export function folded(
	expanded: ReadonlySet<string>,
	tasks: ActivityTask[],
	taskId: string,
): Set<string> {
	const groups = new Set<string>();
	let parents = new Set([taskId]);
	while (parents.size > 0) {
		const level = tasks.filter(
			(task) =>
				task.parentId !== null && parents.has(task.parentId) && !groups.has(groupId([task])),
		);
		for (const task of level) {
			groups.add(groupId([task]));
		}
		parents = new Set(level.map((task) => task.id));
	}
	return new Set([...expanded].filter((id) => id !== taskId && !groups.has(id)));
}

/** The id of the group row these tasks make, from its first member's. */
export function groupId(members: ActivityTask[]): string {
	return `group:${members[0]?.id ?? ''}`;
}

// Tasks handed from one task, in the order started, each on its own but for runs of two or more
// short ones less than the gap apart, which go together.
function grouped(children: ActivityTask[], spanOf: (task: ActivityTask) => Span): ActivityTask[][] {
	const short = (task: ActivityTask) => {
		const span = spanOf(task);
		return span.end - span.start < SHORT_PX;
	};
	const items: ActivityTask[][] = [];
	for (const task of children) {
		const last = items[items.length - 1];
		const previous = last?.[last.length - 1];
		if (
			last &&
			previous &&
			short(previous) &&
			short(task) &&
			spanOf(task).start - Math.max(...last.map((member) => spanOf(member).end)) < GROUP_GAP_PX
		) {
			last.push(task);
			continue;
		}
		items.push([task]);
	}
	return items;
}
