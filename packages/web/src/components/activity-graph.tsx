import {useRef, useState} from 'react';
import {Link} from 'react-router';
import type {ActivitySummary} from '@/client/schemas';
import {agentName, formatDay, graphWeeks, summarizeWeek, type GraphDay} from '@/lib/activity-graph';
import {counted} from '@/lib/format';
import type {AgentLogin, Connection} from '@/lib/types';
import {cn} from '@proxy/ui/lib/utils';

// A year on a wide screen, half of one on a phone.
const WEEKS = 52;
const PHONE_WEEKS = 26;

// One hue, the text's, darker the busier the day in light mode and lighter in dark, a day without
// any a faint square.
const LEVELS = [
	'bg-foreground/[0.07]',
	'bg-foreground/20',
	'bg-foreground/40',
	'bg-foreground/65',
	'bg-foreground/90',
];

const ROW_LABELS = ['Mon', '', 'Wed', '', 'Fri', '', ''];

const CELL = 'size-2.5 rounded-[2px]';

// About half a day's tooltip, so one at either end of the grid stays over it.
const TOOLTIP_HALF = 72;

// The month a week's column is labelled with: the one starting in it.
function monthStarting(week: Array<GraphDay | null>): string | null {
	const first = week.find((cell) => cell?.day.endsWith('-01'));
	if (!first) {
		return null;
	}
	return new Date(`${first.day}T00:00`).toLocaleDateString('en-US', {month: 'short'});
}

type Hovered = {cell: GraphDay; left: number; top: number};

// Under the home page's input: what the agents, and the person from the home page, did each day of
// the past year, and the past week in a line, or with nothing done yet, that it will show here.
// Each busy day opens its part of the activity log.
export function ActivityGraph({
	summary,
	agents,
	connections,
}: {
	summary: ActivitySummary;
	agents: AgentLogin[];
	connections: Connection[];
}) {
	const frame = useRef<HTMLDivElement>(null);
	const [hovered, setHovered] = useState<Hovered | null>(null);
	const weeks = graphWeeks(summary, WEEKS);
	const week = summarizeWeek(summary.week, connections);
	const show = (cell: GraphDay, target: HTMLElement) => {
		const outer = frame.current?.getBoundingClientRect();
		const box = target.getBoundingClientRect();
		if (!outer) {
			return;
		}
		// Kept clear of the edges, where half a tooltip would hang off a phone's screen.
		const middle = box.left - outer.left + box.width / 2;
		const left = Math.min(Math.max(middle, TOOLTIP_HALF), outer.width - TOOLTIP_HALF);
		setHovered({cell, left, top: box.top - outer.top});
	};

	return (
		<section aria-label="Activity" className="flex w-full max-w-2xl flex-col items-center gap-3">
			<div className="flex flex-col items-end gap-2">
				<div ref={frame} className="relative flex gap-[2px]" onMouseLeave={() => setHovered(null)}>
					<div className="mr-1 flex flex-col gap-[2px] pt-5 text-xs text-muted-foreground">
						{ROW_LABELS.map((label, row) => (
							<span key={row} className="h-2.5 leading-[10px]">
								{label}
							</span>
						))}
					</div>
					{weeks.map((column, index) => (
						<div
							key={column[0]?.day ?? index}
							className={cn(
								'flex flex-col gap-[2px]',
								index < WEEKS - PHONE_WEEKS && 'hidden md:flex',
							)}
						>
							<span className="h-[18px] w-2.5 overflow-visible text-xs whitespace-nowrap text-muted-foreground">
								{monthStarting(column)}
							</span>
							{column.map((cell, weekday) => (
								<Cell
									key={cell?.day ?? weekday}
									cell={cell}
									onShow={show}
									onHide={() => setHovered(null)}
								/>
							))}
						</div>
					))}
					{hovered && <DayTooltip hovered={hovered} agents={agents} />}
				</div>
				<div aria-hidden className="flex items-center gap-[2px] text-xs text-muted-foreground">
					<span className="mr-1">Less</span>
					{LEVELS.map((color) => (
						<span key={color} className={cn(CELL, color)} />
					))}
					<span className="ml-1">More</span>
				</div>
			</div>
			{summary.days.length === 0 && (
				<p className="text-center text-sm text-muted-foreground">
					Your agents’ activity will show up here
				</p>
			)}
			{summary.days.length > 0 && (
				<p className="text-center text-sm text-balance text-muted-foreground">
					{week.total === 0 ? 'No requests' : counted(week.total, 'request')} in the past week
					{week.done.length > 0 && `: ${week.done.map(lowerFirst).join(', ')}`}
					{week.denied > 0 && (
						<>
							{' · '}
							<Link
								to="/activity?outcome=denied"
								className="text-destructive transition-colors hover:underline"
							>
								{week.denied} blocked
							</Link>
						</>
					)}
				</p>
			)}
		</section>
	);
}

function lowerFirst(text: string): string {
	return text.charAt(0).toLowerCase() + text.slice(1);
}

function Cell({
	cell,
	onShow,
	onHide,
}: {
	cell: GraphDay | null;
	onShow: (cell: GraphDay, target: HTMLElement) => void;
	onHide: () => void;
}) {
	if (!cell) {
		return <span className={CELL} onMouseEnter={onHide} />;
	}

	const color = LEVELS[cell.level];
	if (cell.count === 0) {
		return (
			<span
				className={cn(CELL, color)}
				onMouseEnter={(event) => onShow(cell, event.currentTarget)}
			/>
		);
	}

	return (
		<Link
			to={`/activity?day=${cell.day}`}
			aria-label={`${formatDay(cell.day)}: ${counted(cell.count, 'request')}`}
			onMouseEnter={(event) => onShow(cell, event.currentTarget)}
			onFocus={(event) => onShow(cell, event.currentTarget)}
			onBlur={onHide}
			className={cn(
				CELL,
				color,
				'outline-offset-1 transition-shadow hover:ring-1 hover:ring-foreground focus-visible:outline-2 focus-visible:outline-ring',
			)}
		/>
	);
}

// What a day came to: its count first, then the day and each agent's part, and what was refused.
function DayTooltip({hovered, agents}: {hovered: Hovered; agents: AgentLogin[]}) {
	const {cell} = hovered;
	return (
		<div
			role="tooltip"
			style={{left: hovered.left, top: hovered.top}}
			className="pointer-events-none absolute z-50 flex w-max max-w-xs -translate-x-1/2 -translate-y-[calc(100%+6px)] flex-col gap-0.5 rounded-md bg-foreground px-3 py-1.5 text-xs text-background"
		>
			<span>
				<span className="font-medium">{counted(cell.count, 'request')}</span>
				<span className="opacity-70"> · {formatDay(cell.day)}</span>
			</span>
			{cell.agents.map((agent) => (
				<span key={agent.agentId ?? 'proxy'} className="flex justify-between gap-4 opacity-70">
					<span className="truncate">{agentName(agent.agentId, agents)}</span>
					<span className="tabular-nums">{agent.count.toLocaleString('en-US')}</span>
				</span>
			))}
			{cell.denied > 0 && <span className="opacity-70">{cell.denied} blocked</span>}
		</div>
	);
}
