import {ArrowUpIcon, MoonIcon, PlusIcon, SearchIcon, WrenchIcon} from 'lucide-react';
import {type FormEvent, type KeyboardEvent, useEffect, useRef, useState} from 'react';
import {Link, useLoaderData, useNavigate, useRevalidator} from 'react-router';
import {Result} from 'ts-results-es';
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
import {Bubble, BubbleContent} from '@proxy/ui/components/bubble';
import {Input} from '@proxy/ui/components/input';
import {
	InputGroup,
	InputGroupAddon,
	InputGroupButton,
	InputGroupTextarea,
} from '@proxy/ui/components/input-group';
import {Message, MessageContent} from '@proxy/ui/components/message';
import {
	MessageScroller,
	MessageScrollerButton,
	MessageScrollerContent,
	MessageScrollerItem,
	MessageScrollerProvider,
	MessageScrollerViewport,
} from '@proxy/ui/components/message-scroller';
import {
	Trace,
	TraceCollapsible,
	TraceCollapsibleContent,
	TraceCollapsibleTrigger,
	TraceIcon,
	TraceLine,
	TraceTitle,
} from '@proxy/ui/components/trace';
import {cn} from '@proxy/ui/lib/utils';
import {formatDateTime} from '@/lib/format';
import {describeFetchError} from '@/lib/loader-utils';
import type {chatLoader} from '@/loaders';

// How often the log is read again while the agent is at work, and while it is not: a reply, or a
// wake-up, shows within a moment either way.
const BUSY_POLL_MS = 1000;
const IDLE_POLL_MS = 4000;

// A call's arguments as the model wrote them; none where they aren't JSON.
function parseArgs(json: string): Record<string, unknown> {
	const parsed = Result.wrap((): unknown => JSON.parse(json));
	if (parsed.isErr() || typeof parsed.value !== 'object' || parsed.value === null) {
		return {};
	}
	return parsed.value as Record<string, unknown>;
}

// JSON as it is shown: laid out where it parses, as written where it doesn't.
function pretty(json: string): string {
	return Result.wrap((): unknown => JSON.parse(json))
		.map((value) => JSON.stringify(value, null, 2))
		.unwrapOr(json);
}

type CallState = 'running' | 'done' | 'failed';

// What a call did, in a few words, from its name and arguments, as it runs, once it has, and
// where it failed: "Running entries_list", "Ran entries_list", "Failed to run entries_list".
function callTitle(call: ChatToolCall, state: CallState): string {
	const args = parseArgs(call.arguments);
	const said = (verbs: [string, string, string], what: string) =>
		`${verbs[state === 'running' ? 0 : state === 'done' ? 1 : 2]} ${what}`;
	if (call.name === 'list_connections') {
		return said(['Listing', 'Listed', 'Failed to list'], 'connections');
	}
	if (call.name === 'list_tools') {
		return said(['Listing', 'Listed', 'Failed to list'], 'tools');
	}
	if (call.name === 'sleep_until') {
		const until =
			typeof args.until === 'string'
				? formatDateTime(args.until)
				: typeof args.seconds === 'number'
					? `${args.seconds} seconds from now`
					: 'later';
		return said(['Sleeping until', 'Slept until', 'Failed to sleep until'], until);
	}
	if (call.name === 'send_feedback') {
		return said(['Sending', 'Sent', 'Failed to send'], 'feedback');
	}
	return said(
		['Running', 'Ran', 'Failed to run'],
		typeof args.tool === 'string' ? args.tool : call.name,
	);
}

// One call the agent made: a line that says what it did, opening to what it asked and what came back.
function ToolCallTrace({call, result}: {call: ChatToolCall; result: ChatEntry | undefined}) {
	const status = result === undefined ? 'running' : result.isError ? 'error' : undefined;
	const title = callTitle(
		call,
		result === undefined ? 'running' : result.isError ? 'failed' : 'done',
	);
	return (
		<TraceCollapsible>
			<TraceCollapsibleTrigger>
				<TraceLine status={status}>
					<TraceIcon>{call.name === 'sleep_until' ? <MoonIcon /> : <WrenchIcon />}</TraceIcon>
					<TraceTitle>{title}</TraceTitle>
				</TraceLine>
			</TraceCollapsibleTrigger>
			<TraceCollapsibleContent className="flex flex-col gap-2 font-mono text-xs">
				<pre className="whitespace-pre-wrap break-all">{pretty(call.arguments)}</pre>
				{result && (
					<pre
						className={cn(
							'max-h-64 overflow-auto whitespace-pre-wrap break-all border-t pt-2',
							result.isError && 'text-destructive',
						)}
					>
						{pretty(result.text)}
					</pre>
				)}
			</TraceCollapsibleContent>
		</TraceCollapsible>
	);
}

// One turn of the conversation: what the person said in a bubble on the right, or what the agent
// said as plain text on the left, with the calls it made as lines above it.
function Turn({entry, results}: {entry: ChatEntry; results: Map<string | null, ChatEntry>}) {
	if (entry.kind === 'person') {
		return (
			<Message align="end">
				<MessageContent>
					<Bubble align="end" variant="muted">
						<BubbleContent className="whitespace-pre-wrap">{entry.text}</BubbleContent>
					</Bubble>
				</MessageContent>
			</Message>
		);
	}
	const calls = entry.toolCalls ?? [];
	return (
		<Message>
			<MessageContent className="gap-2">
				{calls.length > 0 && (
					<Trace>
						{calls.map((call) => (
							<ToolCallTrace key={call.id} call={call} result={results.get(call.id)} />
						))}
					</Trace>
				)}
				{entry.text !== '' && (
					<div className="whitespace-pre-wrap leading-relaxed wrap-break-word">{entry.text}</div>
				)}
			</MessageContent>
		</Message>
	);
}

// What the agent is up to when it isn't answering: at work, or asleep until a time.
function Status({log}: {log: ThreadLog}) {
	if (log.busy) {
		return (
			<TraceLine status="running">
				<TraceTitle>Working</TraceTitle>
			</TraceLine>
		);
	}
	if (log.sleepingUntil === null) {
		return null;
	}
	return (
		<TraceLine>
			<TraceIcon>
				<MoonIcon />
			</TraceIcon>
			<TraceTitle>Asleep until {formatDateTime(log.sleepingUntil)}</TraceTitle>
		</TraceLine>
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
	const form = useRef<HTMLFormElement>(null);
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

	const send = async (event: FormEvent) => {
		event.preventDefault();
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

	// Enter sends; Shift+Enter breaks the line.
	const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
		if (event.key === 'Enter' && !event.shiftKey) {
			event.preventDefault();
			form.current?.requestSubmit();
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

	// Each call's result by the call, folded into the call's line rather than shown as a turn.
	const results = new Map(
		log.entries
			.filter((entry) => entry.kind === 'tool_result')
			.map((entry) => [entry.callId, entry]),
	);
	const turns = log.entries.filter((entry) => entry.kind !== 'tool_result');

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
			<MessageScrollerProvider autoScroll defaultScrollPosition="end">
				<MessageScroller className="min-h-0 flex-1">
					<MessageScrollerViewport aria-label="Conversation">
						<MessageScrollerContent className="page-column mx-auto w-full max-w-3xl pt-6 pb-4">
							{turns.length === 0 && (
								<div className="flex flex-1 flex-col items-center justify-center gap-2 py-12 text-center">
									<p className="text-lg font-medium">What do you want done?</p>
									<p className="max-w-md text-sm text-muted-foreground">
										The agent can use what you connected, as far as its access on the Agents page
										allows. Every call it makes is in the activity log.
									</p>
								</div>
							)}
							{turns.map((entry) => (
								<MessageScrollerItem
									key={entry.id}
									messageId={entry.id}
									scrollAnchor={entry.kind === 'person'}
								>
									<Turn entry={entry} results={results} />
								</MessageScrollerItem>
							))}
							{(log.busy || log.sleepingUntil !== null) && (
								<MessageScrollerItem messageId="status">
									<Trace>
										<Status log={log} />
									</Trace>
								</MessageScrollerItem>
							)}
						</MessageScrollerContent>
					</MessageScrollerViewport>
					<MessageScrollerButton />
				</MessageScroller>
			</MessageScrollerProvider>
			<form
				ref={form}
				onSubmit={(event) => void send(event)}
				className="page-column mx-auto flex w-full max-w-3xl shrink-0 flex-col gap-2 pt-2 pb-4"
			>
				{error && <p className="text-sm text-destructive">{error}</p>}
				<InputGroup className="rounded-xl bg-background shadow-xs">
					<InputGroupTextarea
						value={text}
						onChange={(event) => setText(event.target.value)}
						onKeyDown={onKeyDown}
						placeholder="Message the agent"
						aria-label="Message"
						className="min-h-10 p-3"
						rows={1}
					/>
					<InputGroupAddon align="block-end">
						<Link
							to={`/activity?task=${log.thread.taskId}`}
							className="text-xs font-normal underline-offset-4 hover:underline"
						>
							Activity for this conversation
						</Link>
						<InputGroupButton
							type="submit"
							size="icon-sm"
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
		</AppShell>
	);
}
