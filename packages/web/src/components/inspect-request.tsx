import {useEffect, useState} from 'react';
import {Badge} from '@proxy/ui/components/badge';
import {cn} from '@proxy/ui/lib/utils';
import {
	getRequest,
	type InspectedEntry,
	type InspectedThread,
	type ModelMessage,
	type ModelRequest,
} from '@/client/inspect-client';
import {useOrgSlug} from '@/hooks/use-org';
import {formatTime} from '@/lib/format';
import {formatDuration, prettyJson, timedEvents} from '@/lib/inspect';

// The inspector's right column: what the model was sent for the answer picked in the log, as the
// api rebuilds it, the system prompt, the messages and the tools; what came back; and what
// happened to the job that ran it.

const ROLE_CLASS: Record<ModelMessage['role'], string> = {
	system: 'bg-muted text-muted-foreground',
	user: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
	assistant: 'bg-blue-500/15 text-blue-700 dark:text-blue-300',
	tool: 'bg-muted text-muted-foreground',
};

function Section({title, children}: {title: string; children: React.ReactNode}) {
	return (
		<section className="flex flex-col gap-2 border-b p-3">
			<h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{title}</h3>
			{children}
		</section>
	);
}

function MessageCard({message}: {message: ModelMessage}) {
	const calls = message.role === 'assistant' ? (message.tool_calls ?? []) : [];
	const content = message.role === 'tool' ? message.content : (message.content ?? '');
	return (
		<li className="flex flex-col gap-1 rounded-md border p-2">
			<div className="flex items-center gap-2 text-xs text-muted-foreground">
				<Badge variant="outline" className={cn('border-transparent', ROLE_CLASS[message.role])}>
					{message.role}
				</Badge>
				{message.role === 'tool' && <span className="font-mono">{message.tool_call_id}</span>}
				<span className="ml-auto">{content.length.toLocaleString('en-US')} chars</span>
			</div>
			{content !== '' && (
				<details open={message.role !== 'system' && content.length < 1200}>
					<summary className="cursor-pointer text-xs text-muted-foreground">
						{content.slice(0, 80).replace(/\s+/g, ' ')}…
					</summary>
					<pre className="pt-1 font-sans text-xs whitespace-pre-wrap">{content}</pre>
				</details>
			)}
			{calls.map((call) => (
				<div key={call.id} className="rounded-md bg-muted/40 p-2">
					<div className="flex gap-2 font-mono text-xs">
						<span className="font-medium">{call.function.name}</span>
						<span className="text-muted-foreground">{call.id}</span>
					</div>
					<pre className="pt-1 font-mono text-xs whitespace-pre-wrap">
						{prettyJson(call.function.arguments)}
					</pre>
				</div>
			))}
		</li>
	);
}

// What happened to the job that wrote the entry: each claim, requeue, finish and failure.
function JobHistory({entry, thread}: {entry: InspectedEntry; thread: InspectedThread}) {
	const job = thread.jobs.find((candidate) => candidate.id === entry.jobId);
	const events = thread.events.filter((event) => event.jobId === entry.jobId);
	if (!job) {
		return <p className="text-xs text-muted-foreground">No job is kept for this entry.</p>;
	}
	return (
		<ul className="flex flex-col gap-1 text-xs">
			<li className="font-mono text-muted-foreground">
				{job.id} · {job.kind} · {job.status} · {job.attempts}{' '}
				{job.attempts === 1 ? 'attempt' : 'attempts'}
			</li>
			{timedEvents(events).map(({event, sinceClaimMs}) => (
				<li key={event.id} className="flex flex-wrap gap-2">
					<span className="font-mono">{formatTime(event.at)}</span>
					<span className="font-medium">{event.kind}</span>
					{event.workerId !== null && (
						<span className="text-muted-foreground">{event.workerId}</span>
					)}
					{sinceClaimMs !== null && (
						<span className="text-muted-foreground">after {formatDuration(sinceClaimMs)}</span>
					)}
					{event.error !== null && <span className="text-destructive">{event.error}</span>}
				</li>
			))}
		</ul>
	);
}

export function RequestPane({
	entry,
	thread,
}: {
	entry: InspectedEntry | null;
	thread: InspectedThread;
}) {
	const org = useOrgSlug();
	const [request, setRequest] = useState<{
		entryId: string;
		result: ModelRequest | null;
		error: string | null;
	} | null>(null);

	useEffect(() => {
		if (!entry) {
			return;
		}
		let stale = false;
		void getRequest(org, entry.id).then((result) => {
			if (stale) {
				return;
			}
			setRequest({
				entryId: entry.id,
				result: result.isOk() ? result.value : null,
				error: result.isErr() ? 'The request could not be read.' : null,
			});
		});
		return () => {
			stale = true;
		};
	}, [org, entry]);

	if (!entry) {
		return (
			<p className="p-4 text-sm text-muted-foreground">
				Pick an answer or a summary in the log to see what the model was sent for it.
			</p>
		);
	}
	const loaded = request?.entryId === entry.id ? request : null;
	return (
		<div className="flex flex-col">
			<Section title={`Request for #${entry.seq}`}>
				{loaded === null && <p className="text-xs text-muted-foreground">Reading…</p>}
				{loaded?.error !== null && loaded?.error !== undefined && (
					<p className="text-xs text-destructive">{loaded.error}</p>
				)}
				{loaded?.result && loaded.result.system === null && (
					<p className="text-xs text-muted-foreground">
						This answer was written without the model, so there was no request; the messages are the
						log as it was.
					</p>
				)}
				{loaded?.result && (
					<p className="text-xs text-muted-foreground">
						{loaded.result.kind === 'summary' ? 'A summarization' : 'A turn'}:{' '}
						{loaded.result.messages.length} messages, {loaded.result.tools.length} tools
					</p>
				)}
			</Section>
			{loaded?.result && (
				<>
					<Section title="Messages">
						<ul className="flex flex-col gap-1">
							{loaded.result.messages.map((message, index) => (
								<MessageCard key={index} message={message} />
							))}
						</ul>
					</Section>
					{loaded.result.tools.length > 0 && (
						<Section title="Tools">
							<ul className="flex flex-col gap-1">
								{loaded.result.tools.map((tool) => (
									<li key={tool.name}>
										<details>
											<summary className="cursor-pointer font-mono text-xs">{tool.name}</summary>
											<p className="pt-1 text-xs text-muted-foreground">{tool.description}</p>
											<pre className="pt-1 font-mono text-xs whitespace-pre-wrap">
												{JSON.stringify(tool.parameters, null, 2)}
											</pre>
										</details>
									</li>
								))}
							</ul>
						</Section>
					)}
				</>
			)}
			<Section title="Answer">
				<p className="text-xs text-muted-foreground">
					{(entry.inputTokens ?? 0).toLocaleString('en-US')} tokens in,{' '}
					{(entry.outputTokens ?? 0).toLocaleString('en-US')} out
					{entry.toolCalls &&
						entry.toolCalls.length > 0 &&
						`, ${entry.toolCalls.length} ${entry.toolCalls.length === 1 ? 'call' : 'calls'}`}
				</p>
				{entry.text !== '' && (
					<pre className="font-sans text-xs whitespace-pre-wrap">{entry.text}</pre>
				)}
			</Section>
			<Section title="Job">
				<JobHistory entry={entry} thread={thread} />
			</Section>
		</div>
	);
}
