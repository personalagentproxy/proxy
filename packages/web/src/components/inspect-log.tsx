import {Badge} from '@proxy/ui/components/badge';
import {Button} from '@proxy/ui/components/button';
import {cn} from '@proxy/ui/lib/utils';
import type {InspectedEntry, InspectedThread, ThreadState} from '@/client/inspect-client';
import {formatTime} from '@/lib/format';
import {coveredSeq, prettyJson} from '@/lib/inspect';

// The inspector's middle: a thread's whole log as the harness has it, every entry with what the
// model doesn't see (its seq, its cost, its job), and above it where the thread stands for the
// harness: whether the model is due, what holds it, how close the log is to being summarized.

// Text longer than this is folded, with its length shown.
const FOLD_AT = 600;

const KIND_CLASS: Record<InspectedEntry['kind'], string> = {
	person: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
	assistant: 'bg-blue-500/15 text-blue-700 dark:text-blue-300',
	tool_result: 'bg-muted text-muted-foreground',
	event: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
	summary: 'bg-violet-500/15 text-violet-700 dark:text-violet-300',
};

function Folded({text, open = false}: {text: string; open?: boolean}) {
	if (text.length <= FOLD_AT) {
		return <pre className="font-sans text-sm whitespace-pre-wrap">{text}</pre>;
	}
	return (
		<details open={open}>
			<summary className="cursor-pointer text-xs text-muted-foreground">
				{text.length.toLocaleString('en-US')} characters
			</summary>
			<pre className="pt-1 font-sans text-sm whitespace-pre-wrap">{text}</pre>
		</details>
	);
}

function Calls({entry}: {entry: InspectedEntry}) {
	const calls = entry.toolCalls ?? [];
	if (calls.length === 0) {
		return null;
	}
	return (
		<ul className="flex flex-col gap-1">
			{calls.map((call) => (
				<li key={call.id} className="rounded-md border bg-muted/40 p-2">
					<div className="flex items-baseline gap-2 text-xs">
						<span className="font-mono font-medium">{call.name}</span>
						<span className="font-mono text-muted-foreground">{call.id}</span>
					</div>
					<pre className="pt-1 overflow-x-auto font-mono text-xs whitespace-pre-wrap">
						{prettyJson(call.arguments)}
					</pre>
				</li>
			))}
		</ul>
	);
}

// What an entry says beside its kind: which call it answers, how far a summary reaches.
function lead(entry: InspectedEntry): string | null {
	if (entry.kind === 'tool_result') {
		return `answers ${entry.callId ?? '?'}`;
	}
	if (entry.kind === 'event') {
		return `report for ${entry.callId ?? '?'}`;
	}
	if (entry.kind === 'summary') {
		return `covers up to #${entry.coversSeq ?? '?'}`;
	}
	return null;
}

function EntryCard({
	entry,
	covered,
	selected,
	onSelect,
}: {
	entry: InspectedEntry;
	covered: boolean;
	selected: boolean;
	onSelect: (entryId: string) => void;
}) {
	const askable = entry.kind === 'assistant' || entry.kind === 'summary';
	const tokens = entry.inputTokens !== null || entry.outputTokens !== null;
	return (
		<li
			className={cn(
				'flex flex-col gap-2 rounded-lg border p-3',
				covered && 'opacity-60',
				entry.pending && 'border-dashed',
				entry.isError && 'border-destructive/50',
				selected && 'ring-2 ring-ring/50',
			)}
		>
			<div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
				<span className="font-mono">#{entry.seq}</span>
				<Badge variant="outline" className={cn('border-transparent', KIND_CLASS[entry.kind])}>
					{entry.kind}
				</Badge>
				{lead(entry) && <span className="font-mono">{lead(entry)}</span>}
				<span>{formatTime(entry.at)}</span>
				{tokens && (
					<span>
						{(entry.inputTokens ?? 0).toLocaleString('en-US')} in /{' '}
						{(entry.outputTokens ?? 0).toLocaleString('en-US')} out
					</span>
				)}
				{entry.pending && <Badge variant="outline">pending</Badge>}
				{entry.isError && <Badge variant="destructive">error</Badge>}
				{covered && <Badge variant="outline">summarized</Badge>}
				{entry.jobId !== null && <span className="font-mono">job {entry.jobId.slice(-6)}</span>}
				{askable && (
					<Button
						variant={selected ? 'secondary' : 'ghost'}
						size="xs"
						className="ml-auto"
						onClick={() => onSelect(entry.id)}
					>
						Request
					</Button>
				)}
			</div>
			{entry.text !== '' && <Folded text={entry.text} open={entry.kind !== 'tool_result'} />}
			<Calls entry={entry} />
		</li>
	);
}

// Where the thread stands for the harness.
function StateStrip({state, pending}: {state: ThreadState; pending: number}) {
	const share = Math.min(1, state.lastInputTokens / state.compactAtTokens);
	const holds =
		state.pendingCalls.length > 0
			? `waiting on ${state.pendingCalls.map((call) => call.name).join(', ')}`
			: state.ready
				? 'model due'
				: 'nothing new for the model';
	return (
		<div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b px-4 py-2 text-xs text-muted-foreground">
			<span className={cn(state.ready && 'text-foreground')}>{holds}</span>
			{pending > 0 && <span>{pending} pending</span>}
			<span>
				{state.turnsAlone}/{state.maxTurnsAlone} steps alone
			</span>
			<span className="flex items-center gap-2">
				<span>
					{state.lastInputTokens.toLocaleString('en-US')}/
					{state.compactAtTokens.toLocaleString('en-US')} tokens
				</span>
				<span className="h-1.5 w-16 overflow-hidden rounded-full bg-muted" aria-hidden>
					<span className="block h-full bg-foreground/60" style={{width: `${share * 100}%`}} />
				</span>
			</span>
			{state.compactionCoversSeq !== null && (
				<span>next turn summarizes up to #{state.compactionCoversSeq}</span>
			)}
		</div>
	);
}

export function ThreadLog({
	thread,
	selectedEntryId,
	onSelectEntry,
}: {
	thread: InspectedThread;
	selectedEntryId: string | null;
	onSelectEntry: (entryId: string) => void;
}) {
	const covered = coveredSeq(thread.entries);
	const pending = thread.entries.filter((entry) => entry.pending).length;
	return (
		<>
			<StateStrip state={thread.state} pending={pending} />
			<div className="min-h-0 flex-1 overflow-y-auto">
				<ul aria-label="Log" className="flex flex-col gap-2 p-4">
					{thread.entries.length === 0 && (
						<li className="py-8 text-center text-sm text-muted-foreground">
							Nothing in the log yet.
						</li>
					)}
					{thread.entries.map((entry) => (
						<EntryCard
							key={entry.id}
							entry={entry}
							covered={entry.kind !== 'summary' && entry.seq <= covered}
							selected={entry.id === selectedEntryId}
							onSelect={onSelectEntry}
						/>
					))}
				</ul>
			</div>
		</>
	);
}
