import {ArrowUpIcon, BotIcon, ChevronDownIcon, MoonIcon, PlusIcon, WrenchIcon} from 'lucide-react';
import {type FormEvent, type KeyboardEvent, useEffect, useRef, useState} from 'react';
import {Link, useLoaderData, useNavigate, useRevalidator} from 'react-router';
import {Result} from 'ts-results-es';
import {
	type ChatAgent,
	type ChatEntry,
	type ChatSubAgent,
	type ChatToolCall,
	createChatAgent,
	deleteChatAgent,
	getThread,
	type Persona,
	postMessage,
	type ThreadLog,
	updateChatAgent,
} from '@/client/harness-client';
import {AppShell} from '@/components/app-shell';
import {Avatar} from '@/components/avatar';
import {PersonaDialog} from '@/components/persona-dialog';
import {Bubble, BubbleContent} from '@proxy/ui/components/bubble';
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
import {useOrgSlug} from '@/hooks/use-org';
import {formatAgo, formatDateTime} from '@/lib/format';
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
// where it failed: "Running entries_list", "Ran entries_list", "Failed to run entries_list"; a
// delegation by the sub-agent's title.
function callTitle(call: ChatToolCall, state: CallState): string {
	const args = parseArgs(call.arguments);
	const said = (verbs: [string, string, string], what: string) =>
		`${verbs[state === 'running' ? 0 : state === 'done' ? 1 : 2]} ${what}`;
	if (call.name === 'delegate') {
		const title = typeof args.title === 'string' ? args.title : 'a sub-agent';
		return said(['Working on', 'Done with', 'Failed'], title);
	}
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

// One call the agent made: a line that says what it did, opening to what it asked and what came
// back. A delegation opens to the sub-agent's brief and its report, with a way to its activity.
function ToolCallTrace({
	call,
	result,
	subAgent,
}: {
	call: ChatToolCall;
	result: ChatEntry | undefined;
	subAgent: ChatSubAgent | undefined;
}) {
	const org = useOrgSlug();
	const status = result === undefined ? 'running' : result.isError ? 'error' : undefined;
	const title = callTitle(
		call,
		result === undefined ? 'running' : result.isError ? 'failed' : 'done',
	);
	const args = parseArgs(call.arguments);
	const delegated = call.name === 'delegate';
	return (
		<TraceCollapsible>
			<TraceCollapsibleTrigger>
				<TraceLine status={status}>
					<TraceIcon>
						{delegated ? <BotIcon /> : call.name === 'sleep_until' ? <MoonIcon /> : <WrenchIcon />}
					</TraceIcon>
					<TraceTitle>{title}</TraceTitle>
				</TraceLine>
			</TraceCollapsibleTrigger>
			<TraceCollapsibleContent className="flex flex-col gap-2 text-xs">
				{delegated ? (
					<p className="whitespace-pre-wrap text-muted-foreground">
						{typeof args.brief === 'string' ? args.brief : pretty(call.arguments)}
					</p>
				) : (
					<pre className="whitespace-pre-wrap break-all font-mono">{pretty(call.arguments)}</pre>
				)}
				{result && (
					<pre
						className={cn(
							'max-h-64 overflow-auto whitespace-pre-wrap break-all border-t pt-2',
							!delegated && 'font-mono',
							result.isError && 'text-destructive',
						)}
					>
						{delegated ? result.text : pretty(result.text)}
					</pre>
				)}
				{subAgent && (
					<Link
						to={`/${org}/activity?task=${subAgent.taskId}`}
						className="w-fit underline-offset-4 hover:underline"
					>
						Activity of this sub-agent
					</Link>
				)}
			</TraceCollapsibleContent>
		</TraceCollapsible>
	);
}

// One turn of the conversation: what the person said in a bubble on the right, or what the agent
// said as plain text on the left, with the calls it made as lines above it.
function Turn({
	entry,
	results,
	subAgents,
}: {
	entry: ChatEntry;
	results: Map<string | null, ChatEntry>;
	subAgents: Map<string, ChatSubAgent>;
}) {
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
							<ToolCallTrace
								key={call.id}
								call={call}
								result={results.get(call.id)}
								subAgent={subAgents.get(call.id)}
							/>
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

// What a row shows under the name: the last thing said in the conversation, the person's with "You:".
function preview(last: ChatAgent['lastMessage']): string {
	if (last === null) {
		return 'Nothing yet';
	}
	return last.kind === 'person' ? `You: ${last.text}` : last.text;
}

// The last thing said in the open conversation, as the page has it, fresher than the list.
function lastOf(log: ThreadLog): ChatAgent['lastMessage'] {
	const last = log.entries.findLast(
		(entry) => (entry.kind === 'person' || entry.kind === 'assistant') && entry.text !== '',
	);
	if (!last || (last.kind !== 'person' && last.kind !== 'assistant')) {
		return null;
	}
	return {kind: last.kind, text: last.text, at: last.at};
}

// The organization's agents in the second sidebar, each with its face, its name and the last
// thing said between it and the person, the open one lit, and a row at the bottom to make a new one.
function AgentList({
	agents,
	current,
	currentLog,
	onNew,
}: {
	agents: ChatAgent[];
	current: string;
	currentLog: ThreadLog;
	onNew: () => void;
}) {
	const org = useOrgSlug();
	return (
		<div className="flex h-full min-h-0 flex-col">
			<div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-2">
				{agents.length === 0 && (
					<span className="px-2 py-1.5 text-sm text-muted-foreground">No agents yet.</span>
				)}
				<ul className="flex flex-col gap-0.5">
					{agents.map((agent) => {
						const last = agent.id === current ? lastOf(currentLog) : agent.lastMessage;
						return (
							<li key={agent.id}>
								<Link
									to={`/${org}/chat/${agent.id}`}
									aria-current={agent.id === current ? 'page' : undefined}
									className={cn(
										'flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
										agent.id === current && 'bg-sidebar-accent text-sidebar-accent-foreground',
									)}
								>
									<Avatar shape={agent.shape} color={agent.color} size="md" />
									<span className="flex min-w-0 flex-1 flex-col">
										<span className="flex items-baseline gap-2">
											<span className="min-w-0 flex-1 truncate text-sm font-medium">
												{agent.name}
											</span>
											{last && (
												<span className="shrink-0 text-xs text-muted-foreground">
													{formatAgo(last.at)}
												</span>
											)}
										</span>
										<span className="truncate text-xs text-muted-foreground">{preview(last)}</span>
									</span>
								</Link>
							</li>
						);
					})}
				</ul>
			</div>
			<div className="shrink-0 border-t p-2">
				<button
					type="button"
					onClick={onNew}
					className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm font-medium hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
				>
					<PlusIcon className="size-4" />
					New
				</button>
			</div>
		</div>
	);
}

type Loaded = Awaited<ReturnType<typeof chatLoader>>;

// The page: the conversation with the agent in its address, started over when the address
// changes, so what one conversation showed never lingers on another.
export function ChatPage() {
	const loaded = useLoaderData<typeof chatLoader>();
	return <Conversation key={loaded.log.agent.id} loaded={loaded} />;
}

// The person's conversation with one of the organization's agents: its log, read again as the
// agent works, and an input. The agent hands each piece of work to a sub-agent, which acts as the
// person and whose calls go through the same gate as any agent's, so its activity is in the log
// by the sub-agent's task.
function Conversation({loaded}: {loaded: Loaded}) {
	const org = useOrgSlug();
	const navigate = useNavigate();
	const revalidator = useRevalidator();
	const [log, setLog] = useState<ThreadLog>(loaded.log);
	const [text, setText] = useState('');
	const [sending, setSending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	// The agent dialog: making a new one, or changing this one; closed as null.
	const [editing, setEditing] = useState<'new' | 'current' | null>(null);
	const form = useRef<HTMLFormElement>(null);
	const agentId = loaded.log.agent.id;
	const current = loaded.log.agent;

	// The log as it is now, while the page is open.
	useEffect(() => {
		let cancelled = false;
		const refresh = async () => {
			const result = await getThread(org, agentId);
			if (!cancelled && result.isOk()) {
				setLog(result.value);
			}
		};
		const timer = setInterval(() => void refresh(), log.busy ? BUSY_POLL_MS : IDLE_POLL_MS);
		return () => {
			cancelled = true;
			clearInterval(timer);
		};
	}, [org, agentId, log.busy]);

	const send = async (event: FormEvent) => {
		event.preventDefault();
		const message = text.trim();
		if (message === '' || sending) {
			return;
		}
		setSending(true);
		setError(null);
		const posted = await postMessage(org, agentId, message);
		setSending(false);
		if (posted.isErr()) {
			setError(describeFetchError(posted.error));
			return;
		}
		setText('');
		const refreshed = await getThread(org, agentId);
		if (refreshed.isOk()) {
			setLog(refreshed.value);
		}
	};

	// Enter sends; Shift+Enter breaks the line.
	const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
		if (event.key === 'Enter' && !event.shiftKey) {
			event.preventDefault();
			form.current?.requestSubmit();
		}
	};

	// Saves the dialog's persona: a new agent, opened; or this one, renamed or refaced.
	const savePersona = async (persona: Persona): Promise<string | null> => {
		if (editing === 'new') {
			const made = await createChatAgent(org, persona);
			if (made.isErr()) {
				return describeFetchError(made.error);
			}
			void navigate(`/${org}/chat/${made.value.agent.id}`);
			return null;
		}
		const changed = await updateChatAgent(org, agentId, persona);
		if (changed.isErr()) {
			return describeFetchError(changed.error);
		}
		await revalidator.revalidate();
		return null;
	};

	// Deletes this agent with everyone's conversations with it, and opens whichever is first.
	const removeAgent = async (): Promise<string | null> => {
		const removed = await deleteChatAgent(org, agentId);
		if (removed.isErr()) {
			return describeFetchError(removed.error);
		}
		void navigate(`/${org}/chat`);
		return null;
	};

	// Each call's result by the call, folded into the call's line rather than shown as a turn. A
	// delegation's is the sub-agent's report, an event, which comes after the call was answered as
	// started: until then the call is under way, so that answer is left out, unless it refused.
	const delegations = new Set(
		log.entries.flatMap((entry) =>
			(entry.toolCalls ?? []).filter((call) => call.name === 'delegate').map((call) => call.id),
		),
	);
	const results = new Map(
		log.entries
			.filter(
				(entry) =>
					entry.kind === 'event' ||
					(entry.kind === 'tool_result' && (entry.isError || !delegations.has(entry.callId ?? ''))),
			)
			.map((entry) => [entry.callId, entry]),
	);
	const subAgents = new Map(log.subAgents.map((sub) => [sub.callId, sub]));
	const turns = log.entries.filter(
		(entry) => entry.kind === 'person' || entry.kind === 'assistant',
	);

	return (
		<AppShell
			title={
				current.mayChange ? (
					<button
						type="button"
						onClick={() => setEditing('current')}
						className="flex min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-sm font-medium outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50"
					>
						<Avatar shape={current.shape} color={current.color} />
						<span className="truncate">{current.name}</span>
						<ChevronDownIcon className="size-4 text-muted-foreground" />
					</button>
				) : (
					<span className="flex min-w-0 items-center gap-2 px-1.5 py-1 text-sm font-medium">
						<Avatar shape={current.shape} color={current.color} />
						<span className="truncate">{current.name}</span>
					</span>
				)
			}
			panel={
				<AgentList
					agents={loaded.agents}
					current={agentId}
					currentLog={log}
					onNew={() => setEditing('new')}
				/>
			}
			panelLabel="Agents"
			scroll="inside"
		>
			{editing !== null && (
				<PersonaDialog
					key={editing === 'new' ? 'new' : agentId}
					open
					initial={
						editing === 'new'
							? null
							: {name: current.name, shape: current.shape, color: current.color}
					}
					onClose={() => setEditing(null)}
					onSave={savePersona}
					onDelete={editing === 'current' ? removeAgent : undefined}
				/>
			)}
			<MessageScrollerProvider autoScroll defaultScrollPosition="end">
				<MessageScroller className="min-h-0 flex-1">
					<MessageScrollerViewport aria-label="Conversation">
						<MessageScrollerContent className="page-column mx-auto w-full max-w-3xl pt-6 pb-4">
							{turns.length === 0 && (
								<div className="flex flex-1 flex-col items-center justify-center gap-2 py-12 text-center">
									<Avatar shape={current.shape} color={current.color} size="lg" />
									<p className="text-lg font-medium">What should {current.name} do?</p>
									<p className="max-w-md text-sm text-muted-foreground">
										This conversation is yours alone. {current.name} hands each piece of work to a
										sub-agent, which can use what is shared with everyone and what you connected
										yourself, as far as its access allows. Every call is in the activity log.
									</p>
								</div>
							)}
							{turns.map((entry) => (
								<MessageScrollerItem
									key={entry.id}
									messageId={entry.id}
									scrollAnchor={entry.kind === 'person'}
								>
									<Turn entry={entry} results={results} subAgents={subAgents} />
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
						placeholder={`Message ${current.name}`}
						aria-label="Message"
						className="min-h-10 p-3"
						rows={1}
					/>
					<InputGroupAddon align="block-end">
						<Link
							to={`/${org}/activity?agent=${agentId}`}
							className="text-xs font-normal underline-offset-4 hover:underline"
						>
							Activity of this agent
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
