import {ChevronRightIcon, MoonIcon, PlusIcon, SearchIcon, SendIcon} from 'lucide-react';
import {type KeyboardEvent, useEffect, useRef, useState} from 'react';
import {Link, useLoaderData, useNavigate, useRevalidator} from 'react-router';
import {
	type ChatEntry,
	type ChatThread,
	type ChatToolCall,
	createThread,
	getThread,
	postMessage,
	type ThreadLog,
} from '@/client/harness-client';
import {AppShell, PageTitle} from '@/components/app-shell';
import {Button} from '@proxy/ui/components/button';
import {Input} from '@proxy/ui/components/input';
import {Textarea} from '@proxy/ui/components/textarea';
import {cn} from '@proxy/ui/lib/utils';
import {formatDateTime} from '@/lib/format';
import {describeFetchError} from '@/lib/loader-utils';
import type {chatLoader} from '@/loaders';

// How often the log is read again while the agent is at work, and while it is not: a reply, or a
// wake-up, shows within a moment either way.
const BUSY_POLL_MS = 1000;
const IDLE_POLL_MS = 4000;

// How much of a call's arguments the card shows on its line.
const ARGS_PREVIEW = 80;

function preview(json: string): string {
	const text = json.replace(/\s+/g, ' ');
	return text.length > ARGS_PREVIEW ? `${text.slice(0, ARGS_PREVIEW - 1)}…` : text;
}

// One call the agent made, with what it answered once it has: opened for the whole of both.
function ToolCallCard({call, result}: {call: ChatToolCall; result: ChatEntry | undefined}) {
	const [open, setOpen] = useState(false);
	return (
		<div
			className={cn(
				'overflow-hidden rounded-lg border text-sm',
				result?.isError && 'border-destructive/50',
			)}
		>
			<button
				type="button"
				onClick={() => setOpen((current) => !current)}
				className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-muted/50"
			>
				<ChevronRightIcon
					className={cn('size-4 shrink-0 transition-transform', open && 'rotate-90')}
				/>
				<span className="font-mono text-xs">{call.name}</span>
				<span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
					{preview(call.arguments)}
				</span>
				<span
					className={cn(
						'shrink-0 text-xs',
						result
							? result.isError
								? 'text-destructive'
								: 'text-muted-foreground'
							: 'text-muted-foreground',
					)}
				>
					{result ? (result.isError ? 'Failed' : 'Done') : 'Running…'}
				</span>
			</button>
			{open && (
				<div className="flex flex-col gap-2 border-t px-3 py-2 font-mono text-xs">
					<pre className="whitespace-pre-wrap break-all">{call.arguments}</pre>
					{result && (
						<pre
							className={cn(
								'max-h-80 overflow-auto whitespace-pre-wrap break-all border-t pt-2',
								result.isError && 'text-destructive',
							)}
						>
							{result.text}
						</pre>
					)}
				</div>
			)}
		</div>
	);
}

// The log as a conversation: what the person said on the right, what the agent said on the left
// with its calls under it, each call's answer folded into its card.
function Log({entries}: {entries: ChatEntry[]}) {
	const results = new Map(
		entries.filter((entry) => entry.kind === 'tool_result').map((entry) => [entry.callId, entry]),
	);
	return (
		<ol className="flex flex-col gap-4">
			{entries
				.filter((entry) => entry.kind !== 'tool_result')
				.map((entry) => (
					<li
						key={entry.id}
						className={cn('flex flex-col gap-2', entry.kind === 'person' && 'items-end')}
					>
						{entry.text !== '' && (
							<div
								className={cn(
									'max-w-[85%] whitespace-pre-wrap rounded-2xl px-4 py-2 text-sm',
									entry.kind === 'person' ? 'bg-primary text-primary-foreground' : 'bg-muted',
								)}
							>
								{entry.text}
							</div>
						)}
						{entry.toolCalls?.map((call) => (
							<div key={call.id} className="w-full max-w-[85%]">
								<ToolCallCard call={call} result={results.get(call.id)} />
							</div>
						))}
						<span className="text-xs text-muted-foreground">{formatDateTime(entry.at)}</span>
					</li>
				))}
		</ol>
	);
}

// What a thread is called: what the person first said in it, or when it was started.
function threadLabel(thread: ChatThread): string {
	return thread.title ?? `New conversation · ${formatDateTime(thread.createdAt)}`;
}

// The conversations in the second sidebar: a search over their names, a row to start a new one,
// and the recent ones newest first, the open one lit.
function ConversationList({
	threads,
	current,
	onNew,
}: {
	threads: ChatThread[];
	current: string;
	onNew: () => void;
}) {
	const [search, setSearch] = useState('');
	const needle = search.trim().toLowerCase();
	const shown = threads.filter(
		(thread) => needle === '' || threadLabel(thread).toLowerCase().includes(needle),
	);
	const rowClass =
		'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-sidebar-accent hover:text-sidebar-accent-foreground';

	return (
		<div className="flex h-full min-h-0 flex-col gap-2 p-2">
			<div className="relative shrink-0">
				<SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
				<Input
					type="search"
					value={search}
					onChange={(event) => setSearch(event.target.value)}
					placeholder="Search"
					aria-label="Search conversations"
					className="h-9 bg-background pl-8"
				/>
			</div>
			<button
				type="button"
				onClick={onNew}
				className={cn(rowClass, 'bg-sidebar-accent font-medium text-sidebar-accent-foreground')}
			>
				<PlusIcon className="size-4" />
				New
			</button>
			<div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
				<span className="px-2 pt-2 pb-1 text-xs text-muted-foreground">Recents</span>
				{shown.length === 0 && (
					<span className="px-2 py-1.5 text-sm text-muted-foreground">
						{needle === '' ? 'No conversations yet.' : 'Nothing matches.'}
					</span>
				)}
				<ul className="flex flex-col gap-0.5">
					{shown.map((thread) => (
						<li key={thread.id}>
							<Link
								to={`/chat/${thread.id}`}
								aria-current={thread.id === current ? 'page' : undefined}
								className={cn(
									rowClass,
									'block truncate',
									thread.id === current &&
										'bg-sidebar-accent font-medium text-sidebar-accent-foreground',
								)}
							>
								{threadLabel(thread)}
							</Link>
						</li>
					))}
				</ul>
			</div>
		</div>
	);
}

type Loaded = Awaited<ReturnType<typeof chatLoader>>;

// The page: the conversation in its address, started over when the address changes, so what one
// conversation showed never lingers on another.
export function ChatPage() {
	const loaded = useLoaderData<typeof chatLoader>();
	return <Conversation key={loaded.log.thread.id} loaded={loaded} />;
}

// A conversation with the built-in agent: its log, read again as the agent works, and an input.
// The agent's calls go through the same gate as any agent's, so its activity is in the log by the
// conversation's task.
function Conversation({loaded}: {loaded: Loaded}) {
	const navigate = useNavigate();
	const revalidator = useRevalidator();
	const [log, setLog] = useState<ThreadLog>(loaded.log);
	const [text, setText] = useState('');
	const [sending, setSending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	// The log, which scrolls on its own; the input under it stays put.
	const logView = useRef<HTMLDivElement>(null);
	const threadId = loaded.log.thread.id;
	// The thread as the list names it, which the log's own row doesn't.
	const current = loaded.threads.find((thread) => thread.id === threadId) ?? loaded.log.thread;

	// The log as it is now, while the page is open.
	useEffect(() => {
		let cancelled = false;
		const refresh = async () => {
			const result = await getThread(threadId);
			if (!cancelled && result.isOk()) {
				setLog(result.value);
			}
		};
		const timer = setInterval(() => void refresh(), log.busy ? BUSY_POLL_MS : IDLE_POLL_MS);
		return () => {
			cancelled = true;
			clearInterval(timer);
		};
	}, [threadId, log.busy]);

	useEffect(() => {
		logView.current?.scrollTo({top: logView.current.scrollHeight});
	}, [log.entries.length, log.busy]);

	const send = async () => {
		const message = text.trim();
		if (message === '' || sending) {
			return;
		}
		setSending(true);
		setError(null);
		const posted = await postMessage(threadId, message);
		setSending(false);
		if (posted.isErr()) {
			setError(describeFetchError(posted.error));
			return;
		}
		setText('');
		const refreshed = await getThread(threadId);
		if (refreshed.isOk()) {
			setLog(refreshed.value);
		}
		// The first message names the thread in the list.
		if (current.title === null) {
			await revalidator.revalidate();
		}
	};

	const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
		if (event.key === 'Enter' && !event.shiftKey) {
			event.preventDefault();
			void send();
		}
	};

	const startThread = async () => {
		const made = await createThread();
		if (made.isErr()) {
			setError(describeFetchError(made.error));
			return;
		}
		void navigate(`/chat/${made.value.thread.id}`);
	};

	return (
		<AppShell
			title={<PageTitle detail={threadLabel(current)}>Chat</PageTitle>}
			panel={
				<ConversationList
					threads={loaded.threads}
					current={threadId}
					onNew={() => void startThread()}
				/>
			}
			panelLabel="Conversations"
			scroll="inside"
		>
			<div ref={logView} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
				<div className="page-column mx-auto flex w-full max-w-3xl flex-col gap-6 pt-6 pb-2">
					{log.entries.length === 0 ? (
						<p className="text-sm text-muted-foreground">
							Say what you want done. The agent can use what you connected, as far as its access on
							the Agents page allows, and every call it makes is in the activity log.
						</p>
					) : (
						<Log entries={log.entries} />
					)}
					{log.busy && <p className="text-sm text-muted-foreground">Working…</p>}
					{log.sleepingUntil && (
						<p className="flex items-center gap-2 text-sm text-muted-foreground">
							<MoonIcon className="size-4" />
							Asleep until {formatDateTime(log.sleepingUntil)}
						</p>
					)}
				</div>
			</div>
			<div className="page-column mx-auto flex w-full max-w-3xl shrink-0 flex-col gap-2 pt-2 pb-4">
				{error && <p className="text-sm text-destructive">{error}</p>}
				<div className="flex items-end gap-2">
					<Textarea
						value={text}
						onChange={(event) => setText(event.target.value)}
						onKeyDown={onKeyDown}
						placeholder="Message the agent"
						className="min-h-10"
						rows={1}
					/>
					<Button
						size="icon"
						onClick={() => void send()}
						disabled={sending || text.trim() === ''}
						aria-label="Send"
					>
						<SendIcon />
					</Button>
				</div>
				<Link
					to={`/activity?task=${log.thread.taskId}`}
					className="text-xs text-muted-foreground underline-offset-4 hover:underline"
				>
					Activity for this conversation
				</Link>
			</div>
		</AppShell>
	);
}
