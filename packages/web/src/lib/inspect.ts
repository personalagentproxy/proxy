import type {
	InspectedEntry,
	InspectedJob,
	InspectedJobEvent,
	InspectedThread,
} from '@/client/inspect-client';

/**
 * What the inspector says of a thread, a job and a log, worked out from what the api gives:
 * where a thread stands, what a job is for and how long it took, what a summary covers.
 */

/** Where a thread stands, in a word: at work, queued or asleep on a job, waiting for the person (a conversation), reported or failed (a sub-agent). */
export type ThreadStatus = {
	kind: 'working' | 'queued' | 'asleep' | 'waiting' | 'reported' | 'failed';
	// Until when, for one asleep.
	until: string | null;
};

const SLEEP_SOON_MS = 1000;

export function threadStatus(thread: InspectedThread, now: string): ThreadStatus {
	if (thread.finishedAt !== null) {
		const failed = thread.jobs.some((job) => job.status === 'failed');
		return {kind: failed ? 'failed' : 'reported', until: null};
	}
	const open = thread.jobs.filter((job) => job.status === 'queued' || job.status === 'running');
	if (open.some((job) => job.status === 'running')) {
		return {kind: 'working', until: null};
	}
	if (open.length === 0) {
		return {kind: 'waiting', until: null};
	}
	const time = new Date(now).getTime();
	// A queued job due later is a sleep; one due now is about to be claimed.
	const later = open.filter((job) => new Date(job.runAt).getTime() - time > SLEEP_SOON_MS);
	if (later.length === open.length) {
		const first = [...later].sort((a, b) => a.runAt.localeCompare(b.runAt))[0];
		return {kind: 'asleep', until: first?.runAt ?? null};
	}
	return {kind: 'queued', until: null};
}

/** What a thread is called in a list: the conversation, or a sub-agent by its title. */
export function threadLabel(thread: InspectedThread): string {
	return thread.parentThreadId === null ? 'Conversation' : (thread.title ?? 'Sub-agent');
}

/** Each of a job's events with how long after the attempt's claim it came; null for a claim, and before any. */
export function timedEvents(
	events: InspectedJobEvent[],
): Array<{event: InspectedJobEvent; sinceClaimMs: number | null}> {
	let claimedAt: string | null = null;
	return events.map((event) => {
		const since =
			event.kind !== 'claimed' && claimedAt !== null
				? new Date(event.at).getTime() - new Date(claimedAt).getTime()
				: null;
		if (event.kind === 'claimed') {
			claimedAt = event.at;
		}
		return {event, sinceClaimMs: since};
	});
}

/** What a job is for: the model's turn, or the call it runs, by name, found in the entry the call is in. */
export function jobTitle(job: InspectedJob, entries: InspectedEntry[]): string {
	if (job.kind === 'inference') {
		return 'inference';
	}
	const entry = entries.find((candidate) => candidate.id === job.entryId);
	const call = entry?.toolCalls?.find((candidate) => candidate.id === job.callId);
	return call ? call.name : 'tool';
}

/** The sum of what the model's answers in the log cost. */
export function tokensOf(entries: InspectedEntry[]): {input: number; output: number} {
	return entries.reduce(
		(sum, entry) => ({
			input: sum.input + (entry.inputTokens ?? 0),
			output: sum.output + (entry.outputTokens ?? 0),
		}),
		{input: 0, output: 0},
	);
}

/** The seq of the last entry the log's latest summary stands for; -1 where there is none. */
export function coveredSeq(entries: InspectedEntry[]): number {
	return entries.findLast((entry) => entry.kind === 'summary')?.coversSeq ?? -1;
}

/** "340ms", "1.2s", "2m 10s". */
export function formatDuration(ms: number): string {
	if (ms < 1000) {
		return `${Math.max(0, Math.round(ms))}ms`;
	}
	if (ms < 60_000) {
		return `${(ms / 1000).toFixed(1)}s`;
	}
	const minutes = Math.floor(ms / 60_000);
	const seconds = Math.round((ms % 60_000) / 1000);
	return `${minutes}m ${seconds}s`;
}

/** "in 12s", "in 3m 0s"; "due" once the time has come. */
export function formatDue(runAt: string, now: string): string {
	const ms = new Date(runAt).getTime() - new Date(now).getTime();
	if (ms <= 0) {
		return 'due';
	}
	return `in ${formatDuration(ms)}`;
}

/** The job's last attempt, from its events: when it was claimed, and how long it ran, where it ended. */
export function lastAttempt(
	job: InspectedJob,
	events: InspectedJobEvent[],
): {claimedAt: string | null; ranMs: number | null} {
	const own = events.filter((event) => event.jobId === job.id);
	const claimed = own.findLast((event) => event.kind === 'claimed') ?? null;
	const ended =
		own.findLast(
			(event) => event.kind !== 'claimed' && (claimed === null || event.at >= claimed.at),
		) ?? null;
	if (!claimed) {
		return {claimedAt: null, ranMs: null};
	}
	if (!ended) {
		return {claimedAt: claimed.at, ranMs: null};
	}
	return {
		claimedAt: claimed.at,
		ranMs: new Date(ended.at).getTime() - new Date(claimed.at).getTime(),
	};
}

/** The arguments pretty-printed where they are JSON, as written otherwise. */
export function prettyJson(text: string): string {
	try {
		return JSON.stringify(JSON.parse(text), null, 2);
	} catch {
		return text;
	}
}
