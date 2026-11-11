import type {ChatTask} from '@proxy/contracts/harness';
import {CornerDownRightIcon} from 'lucide-react';
import {Link} from 'react-router';
import {Trace, TraceIcon, TraceLine, TraceTitle} from '@/components/chat/trace';

/** That the agent is at work, at the end of the chat. */
export function WorkingLine() {
	return (
		<Trace>
			<TraceLine status="running">
				<TraceTitle>Working</TraceTitle>
			</TraceLine>
		</Trace>
	);
}

/**
 * A line of the conversation about one of its tasks, where the persona started it ("Created
 * task") or sent it more ("Sent to"): the task's title opens its chat.
 */
export function TaskLine({verb, task, to}: {verb: string; task: ChatTask; to: string}) {
	return (
		<Trace>
			<TraceLine>
				<TraceIcon>
					<CornerDownRightIcon />
				</TraceIcon>
				<TraceTitle>
					{verb}{' '}
					<Link
						to={to}
						className="rounded-sm font-medium text-foreground underline-offset-2 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
					>
						{task.title}
					</Link>
				</TraceTitle>
			</TraceLine>
		</Trace>
	);
}
