import {ArrowUpIcon} from 'lucide-react';
import {type FormEvent, type KeyboardEvent, useCallback, useEffect, useRef, useState} from 'react';
import {Link, useLoaderData, useNavigate} from 'react-router';
import {Button} from '@proxy/ui/components/button';
import {
	InputGroup,
	InputGroupAddon,
	InputGroupButton,
	InputGroupTextarea,
} from '@proxy/ui/components/input-group';
import {postMessage} from '@/client/harness-client';
import {getInspection, type Inspection} from '@/client/inspect-client';
import {Head} from '@/components/head';
import {ThreadLog} from '@/components/inspect-log';
import {RequestPane} from '@/components/inspect-request';
import {JobQueue, StatusBadge, ThreadTree} from '@/components/inspect-threads';
import {useOrgSlug} from '@/hooks/use-org';
import {formatTime} from '@/lib/format';
import {threadLabel, threadStatus} from '@/lib/inspect';
import {describeFetchError} from '@/lib/loader-utils';
import type {inspectLoader} from '@/loaders';

/**
 * The inspector: the person's conversation with a persona as the harness has it, on a page of
 * its own, for whoever works on the built-in agent. Nothing of the Chat page: the conversation's
 * threads and the queue on the left, the thread picked in the middle with its whole log and an
 * input to say something in the conversation, and on the right what the model was sent for the
 * answer picked. Read again as the agent works, as the Chat page is.
 */

const BUSY_POLL_MS = 1000;
const IDLE_POLL_MS = 4000;

type Loaded = Awaited<ReturnType<typeof inspectLoader>>;

export function InspectPage() {
	const loaded = useLoaderData<typeof inspectLoader>();
	return <Inspector key={loaded.inspection.persona.id} loaded={loaded} />;
}

function hasOpenJobs(inspection: Inspection): boolean {
	return inspection.threads.some((thread) =>
		thread.jobs.some((job) => job.status === 'queued' || job.status === 'running'),
	);
}

function Inspector({loaded}: {loaded: Loaded}) {
	const org = useOrgSlug();
	const navigate = useNavigate();
	const [inspection, setInspection] = useState(loaded.inspection);
	const [threadId, setThreadId] = useState(loaded.inspection.threads[0]?.id ?? '');
	const [entryId, setEntryId] = useState<string | null>(null);
	const [showHistory, setShowHistory] = useState(false);
	const [text, setText] = useState('');
	const [sending, setSending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const form = useRef<HTMLFormElement>(null);
	const personaId = loaded.inspection.persona.id;
	const busy = hasOpenJobs(inspection);

	const latestRead = useRef(0);
	const read = useCallback(async () => {
		latestRead.current += 1;
		const own = latestRead.current;
		const result = await getInspection(org, personaId);
		if (own !== latestRead.current || result.isErr()) {
			return;
		}
		setInspection(result.value);
	}, [org, personaId]);

	useEffect(() => {
		const timer = setInterval(() => void read(), busy ? BUSY_POLL_MS : IDLE_POLL_MS);
		return () => {
			clearInterval(timer);
		};
	}, [read, busy]);

	const thread =
		inspection.threads.find((candidate) => candidate.id === threadId) ?? inspection.threads[0];
	const entry = thread?.entries.find((candidate) => candidate.id === entryId) ?? null;

	const send = async (event: FormEvent) => {
		event.preventDefault();
		const message = text.trim();
		if (message === '' || sending) {
			return;
		}
		setSending(true);
		setError(null);
		const posted = await postMessage(org, personaId, message);
		setSending(false);
		if (posted.isErr()) {
			setError(describeFetchError(posted.error));
			return;
		}
		setText('');
		await read();
	};

	const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
		if (event.key === 'Enter' && !event.shiftKey) {
			event.preventDefault();
			form.current?.requestSubmit();
		}
	};

	const persona = inspection.persona;
	return (
		<div className="flex h-dvh flex-col bg-background text-foreground">
			<header className="flex h-11 shrink-0 items-center gap-3 border-b px-3 text-sm">
				<Head look={persona.look} color={persona.color} size={24} />
				<span className="font-medium">Inspector</span>
				<select
					aria-label="Persona"
					value={personaId}
					onChange={(event) => void navigate(`/${org}/inspect/${event.target.value}`)}
					className="h-7 rounded-md border bg-background px-1.5 text-sm"
				>
					{loaded.personas.map((candidate) => (
						<option key={candidate.id} value={candidate.id}>
							{candidate.name}
						</option>
					))}
				</select>
				<Link
					to={`/${org}/chat/${personaId}`}
					className="text-xs text-muted-foreground underline-offset-4 hover:underline"
				>
					Open in Chat
				</Link>
				<span className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
					<span className={busy ? 'text-foreground' : undefined}>
						{busy ? 'live, every second' : 'idle, every 4 seconds'}
					</span>
					<span className="font-mono">{formatTime(inspection.now)}</span>
				</span>
			</header>
			<div className="flex min-h-0 flex-1">
				<aside className="flex w-72 shrink-0 flex-col overflow-y-auto border-r">
					<ThreadTree
						threads={inspection.threads}
						now={inspection.now}
						current={thread?.id ?? ''}
						onSelect={setThreadId}
					/>
					<JobQueue
						threads={inspection.threads}
						now={inspection.now}
						showHistory={showHistory}
						onToggleHistory={() => setShowHistory((shown) => !shown)}
						onSelectThread={setThreadId}
					/>
				</aside>
				<main className="flex min-w-0 flex-1 flex-col">
					{thread && (
						<>
							<div className="flex h-9 shrink-0 items-center gap-2 border-b px-4 text-sm">
								<span className="font-medium">{threadLabel(thread)}</span>
								<StatusBadge status={threadStatus(thread, inspection.now)} />
								<span className="font-mono text-xs text-muted-foreground">{thread.id}</span>
								{thread.parentCallId !== null && (
									<span className="font-mono text-xs text-muted-foreground">
										from {thread.parentCallId}
									</span>
								)}
							</div>
							<ThreadLog thread={thread} selectedEntryId={entryId} onSelectEntry={setEntryId} />
							{thread.parentThreadId === null && (
								<form
									ref={form}
									onSubmit={(event) => void send(event)}
									className="flex shrink-0 flex-col gap-1 border-t p-3"
								>
									{error && <p className="text-xs text-destructive">{error}</p>}
									<InputGroup className="rounded-lg bg-background">
										<InputGroupTextarea
											value={text}
											onChange={(event) => setText(event.target.value)}
											onKeyDown={onKeyDown}
											placeholder={`Message ${persona.name}`}
											aria-label="Message"
											className="min-h-9 p-2 text-sm"
											rows={1}
										/>
										<InputGroupAddon align="block-end">
											<InputGroupButton
												type="submit"
												size="icon-xs"
												variant="default"
												className="ml-auto rounded-full"
												disabled={sending || text.trim() === ''}
												aria-label="Send"
											>
												<ArrowUpIcon />
											</InputGroupButton>
										</InputGroupAddon>
									</InputGroup>
								</form>
							)}
						</>
					)}
				</main>
				<aside className="w-[28rem] shrink-0 overflow-y-auto border-l">
					{thread && <RequestPane entry={entry} thread={thread} />}
					{thread && entry && (
						<div className="p-3">
							<Button variant="ghost" size="xs" onClick={() => setEntryId(null)}>
								Clear
							</Button>
						</div>
					)}
				</aside>
			</div>
		</div>
	);
}
