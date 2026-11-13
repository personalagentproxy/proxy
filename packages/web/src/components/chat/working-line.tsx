import {Trace, TraceLine, TraceTitle} from '@/components/chat/trace';

/** That the agent is at work, at the end of a thread. */
export function WorkingLine() {
	return (
		<Trace>
			<TraceLine status="running">
				<TraceTitle>Working</TraceTitle>
			</TraceLine>
		</Trace>
	);
}
