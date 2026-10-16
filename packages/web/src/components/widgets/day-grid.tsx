import type {DayItem} from '@/lib/calendar-day';

const HOUR_PX = 28;
const TIME = new Intl.DateTimeFormat(undefined, {hour: 'numeric', minute: '2-digit'});
// Where the events start, past the hours written down the side (`left-16`).
const GUTTER = '4rem';

function hours(date: Date): number {
	return date.getHours() + date.getMinutes() / 60;
}

type Placed = DayItem & {lane: number; lanes: number};

// Events at the same time side by side: each in the first lane free when it starts, every event
// of a run that overlaps as wide as the run's lanes allow.
function placed(items: DayItem[]): Placed[] {
	const sorted = [...items].sort(
		(a, b) => a.start.getTime() - b.start.getTime() || b.end.getTime() - a.end.getTime(),
	);
	const done: Placed[] = [];
	let run: Array<DayItem & {lane: number}> = [];
	let runEnd = 0;
	const close = () => {
		const lanes = Math.max(1, ...run.map((item) => item.lane + 1));
		done.push(...run.map((item) => ({...item, lanes})));
		run = [];
	};
	for (const item of sorted) {
		if (run.length > 0 && item.start.getTime() >= runEnd) {
			close();
		}
		const taken = run.filter((other) => other.end > item.start).map((other) => other.lane);
		let lane = 0;
		while (taken.includes(lane)) {
			lane += 1;
		}
		run.push({...item, lane});
		runEnd = Math.max(runEnd, item.end.getTime());
	}
	close();
	return done;
}

// A day from 9 to 6, widened to take in its events, the hours down the side and the events beside
// them, the one highlighted in the primary colour, each opening where it is.
export function DayGrid({items}: {items: DayItem[]}) {
	const from = Math.min(9, ...items.map((item) => Math.floor(hours(item.start))));
	const to = Math.max(18, ...items.map((item) => Math.ceil(hours(item.end))));
	const top = (date: Date) => (hours(date) - from) * HOUR_PX;
	const height = (start: Date, end: Date) => Math.max((hours(end) - hours(start)) * HOUR_PX, 18);

	return (
		<div className="relative" style={{height: (to - from) * HOUR_PX}} aria-label="Day">
			{Array.from({length: to - from}, (_, index) => (
				<div
					key={index}
					className="absolute inset-x-0 border-t text-muted-foreground"
					style={{top: index * HOUR_PX}}
				>
					<span className="text-xs">{TIME.format(new Date(2000, 0, 1, from + index))}</span>
				</div>
			))}
			{placed(items).map((item) => {
				const style = {
					top: top(item.start),
					height: height(item.start, item.end),
					left: `calc(${GUTTER} + (100% - ${GUTTER}) * ${item.lane} / ${item.lanes})`,
					width: `calc((100% - ${GUTTER}) / ${item.lanes} - 2px)`,
				};
				const className = `absolute truncate rounded-md px-2 ${item.highlighted ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'}`;
				if (item.link) {
					return (
						<a
							key={item.key}
							href={item.link}
							target="_blank"
							rel="noreferrer"
							aria-current={item.highlighted || undefined}
							className={`${className} hover:underline`}
							style={style}
						>
							{item.title}
						</a>
					);
				}
				return (
					<div
						key={item.key}
						aria-current={item.highlighted || undefined}
						className={className}
						style={style}
					>
						{item.title}
					</div>
				);
			})}
		</div>
	);
}
