import {ArrowUpIcon, ChevronDownIcon, MoonIcon, PlusIcon} from 'lucide-react';
import {type FormEvent, type KeyboardEvent, useEffect, useRef, useState} from 'react';
import {Link, useLoaderData, useNavigate, useRevalidator} from 'react-router';
import {
	type ChatEntry,
	type ChatPersona,
	createPersona,
	deletePersona,
	getThread,
	type Persona,
	postMessage,
	type ThreadLog,
	updatePersona,
} from '@/client/harness-client';
import {AppShell} from '@/components/app-shell';
import {Head, LiveHead} from '@/components/head';
import {Markdown} from '@/components/markdown';
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
import {Trace, TraceIcon, TraceLine, TraceTitle} from '@proxy/ui/components/trace';
import {preview} from '@proxy/utils/harness';
import {cn} from '@proxy/ui/lib/utils';
import {useOrgSlug} from '@/hooks/use-org';
import {formatAgo, formatDateTime} from '@/lib/format';
import {describeFetchError} from '@/lib/loader-utils';
import type {chatLoader} from '@/loaders';

// How often the log is read again while the agent is at work, and while it is not: a reply, or a
// wake-up, shows within a moment either way.
const BUSY_POLL_MS = 1000;
const IDLE_POLL_MS = 4000;

// One turn of the conversation: what the person said in a bubble on the right, as they typed it,
// or what the persona answered in an outlined one on the left, as Markdown, in a red one where
// its turn failed. What it did in between, the sub-agents it started and what they found, is in
// the activity log, not here: this is a conversation.
function Turn({entry}: {entry: ChatEntry}) {
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
	return (
		<Message>
			<MessageContent>
				<Bubble variant={entry.isError ? 'destructive' : 'outline'}>
					<BubbleContent>
						<Markdown text={entry.text} />
					</BubbleContent>
				</Bubble>
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
function subtitle(last: ChatPersona['lastMessage']): string {
	if (last === null) {
		return 'Nothing yet';
	}
	return last.kind === 'person' ? `You: ${last.text}` : last.text;
}

// The last thing said in the open conversation, as the page has it, fresher than the list, cut
// to a line as the list has it.
function lastOf(log: ThreadLog): ChatPersona['lastMessage'] {
	const last = log.entries.at(-1);
	return last ? {kind: last.kind, text: preview(last.text), at: last.at} : null;
}

// The organization's personas in the second sidebar, each with its head, its name and the last
// thing said between it and the person, the open one lit, its head watching the pointer while it
// is over the sidebar, and a row at the bottom to make a new one.
function PersonaList({
	personas,
	current,
	currentLog,
	onNew,
}: {
	personas: ChatPersona[];
	current: string;
	currentLog: ThreadLog;
	onNew: () => void;
}) {
	const org = useOrgSlug();
	const [watching, setWatching] = useState(false);
	return (
		<div
			className="flex h-full min-h-0 flex-col"
			onPointerEnter={() => setWatching(true)}
			onPointerLeave={() => setWatching(false)}
		>
			<div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-2">
				{personas.length === 0 && (
					<span className="px-2 py-1.5 text-sm text-muted-foreground">No agents yet.</span>
				)}
				<ul className="flex flex-col gap-0.5">
					{personas.map((persona) => {
						const last = persona.id === current ? lastOf(currentLog) : persona.lastMessage;
						return (
							<li key={persona.id}>
								<Link
									to={`/${org}/chat/${persona.id}`}
									aria-current={persona.id === current ? 'page' : undefined}
									className={cn(
										'flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
										persona.id === current && 'bg-sidebar-accent text-sidebar-accent-foreground',
									)}
								>
									{persona.id === current ? (
										<LiveHead
											look={persona.look}
											color={persona.color}
											size={40}
											watching={watching}
										/>
									) : (
										<Head look={persona.look} color={persona.color} size={40} />
									)}
									<span className="flex min-w-0 flex-1 flex-col">
										<span className="flex items-baseline gap-2">
											<span className="min-w-0 flex-1 truncate text-sm font-medium">
												{persona.name}
											</span>
											{last && (
												<span className="shrink-0 text-xs text-muted-foreground">
													{formatAgo(last.at)}
												</span>
											)}
										</span>
										<span className="truncate text-xs text-muted-foreground">{subtitle(last)}</span>
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

// The page: the conversation with the persona in its address, started over when the address
// changes, so what one conversation showed never lingers on another.
export function ChatPage() {
	const loaded = useLoaderData<typeof chatLoader>();
	return <Conversation key={loaded.log.persona.id} loaded={loaded} />;
}

// The person's conversation with one of the organization's personas: its log, read again as the
// persona works, and an input. The persona hands each piece of work to a sub-agent, which acts as
// the person through the organization's built-in login, whose calls go through the same gate as
// any agent's, so its activity is in the log by the sub-agent's task.
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
	const personaId = loaded.log.persona.id;
	const current = loaded.log.persona;

	// The log as it is now, while the page is open.
	useEffect(() => {
		let cancelled = false;
		const refresh = async () => {
			const result = await getThread(org, personaId);
			if (!cancelled && result.isOk()) {
				setLog(result.value);
			}
		};
		const timer = setInterval(() => void refresh(), log.busy ? BUSY_POLL_MS : IDLE_POLL_MS);
		return () => {
			cancelled = true;
			clearInterval(timer);
		};
	}, [org, personaId, log.busy]);

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
		const refreshed = await getThread(org, personaId);
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

	// Saves the dialog's persona: a new one, opened; or this one, renamed or refaced.
	const savePersona = async (persona: Persona): Promise<string | null> => {
		if (editing === 'new') {
			const made = await createPersona(org, persona);
			if (made.isErr()) {
				return describeFetchError(made.error);
			}
			void navigate(`/${org}/chat/${made.value.persona.id}`);
			return null;
		}
		const changed = await updatePersona(org, personaId, persona);
		if (changed.isErr()) {
			return describeFetchError(changed.error);
		}
		await revalidator.revalidate();
		return null;
	};

	// Deletes this persona with everyone's conversations with it, and opens whichever is first.
	const removePersona = async (): Promise<string | null> => {
		const removed = await deletePersona(org, personaId);
		if (removed.isErr()) {
			return describeFetchError(removed.error);
		}
		void navigate(`/${org}/chat`);
		return null;
	};

	// Turns in a row from the same side sit closer together than the sides do.
	const runs = log.entries.reduce<ChatEntry[][]>((grouped, entry) => {
		const last = grouped.at(-1);
		if (last && last[0]?.kind === entry.kind) {
			last.push(entry);
			return grouped;
		}
		return [...grouped, [entry]];
	}, []);

	return (
		<AppShell
			title={
				current.mayChange ? (
					<button
						type="button"
						onClick={() => setEditing('current')}
						className="flex min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-sm font-medium outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50"
					>
						<span className="truncate">{current.name}</span>
						<ChevronDownIcon className="size-4 text-muted-foreground" />
					</button>
				) : (
					<span className="flex min-w-0 items-center px-1.5 py-1 text-sm font-medium">
						<span className="truncate">{current.name}</span>
					</span>
				)
			}
			panel={
				<PersonaList
					personas={loaded.personas}
					current={personaId}
					currentLog={log}
					onNew={() => setEditing('new')}
				/>
			}
			panelLabel="Agents"
			scroll="inside"
		>
			{editing !== null && (
				<PersonaDialog
					key={editing === 'new' ? 'new' : personaId}
					open
					initial={
						editing === 'new'
							? null
							: {name: current.name, look: current.look, color: current.color}
					}
					onClose={() => setEditing(null)}
					onSave={savePersona}
					onDelete={editing === 'current' ? removePersona : undefined}
				/>
			)}
			<MessageScrollerProvider autoScroll defaultScrollPosition="end">
				<MessageScroller className="min-h-0 flex-1">
					<MessageScrollerViewport aria-label="Conversation">
						<MessageScrollerContent className="page-column mx-auto w-full max-w-3xl pt-6 pb-4">
							{runs.length === 0 && (
								<div className="flex flex-1 flex-col items-center justify-center gap-2 py-12 text-center">
									<Head look={current.look} color={current.color} size={64} />
									<p className="text-lg font-medium">What should {current.name} do?</p>
									<p className="max-w-md text-sm text-muted-foreground">
										This conversation is yours alone. {current.name} hands each piece of work to a
										sub-agent, which can use what is shared with everyone and what you connected
										yourself, as far as its access allows. Every call is in the activity log.
									</p>
								</div>
							)}
							{runs.map((run) => (
								<MessageScrollerItem
									key={run[0]?.id}
									messageId={run[0]?.id ?? ''}
									scrollAnchor={run[0]?.kind === 'person'}
								>
									<div className="flex flex-col gap-2">
										{run.map((entry) => (
											<Turn key={entry.id} entry={entry} />
										))}
									</div>
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
							to={`/${org}/activity`}
							className="text-xs font-normal underline-offset-4 hover:underline"
						>
							Activity
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
