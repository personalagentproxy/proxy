import type {
	ChatEntry,
	ChatHarness,
	ChatPersona,
	Persona,
	ThreadLog,
} from '@proxy/contracts/harness';
import {ArrowUpIcon, MoonIcon, PencilIcon, Trash2Icon} from 'lucide-react';
import {type FormEvent, type KeyboardEvent, useCallback, useEffect, useRef, useState} from 'react';
import {Link, useNavigate, useParams} from 'react-router';
import {
	createPersona,
	deletePersona,
	getThread,
	postMessage,
	updatePersona,
} from '@/client/harness-client';
import {AddButton} from '@/components/add-button';
import {AppShell, PageTitle, PanelWaiting, TitleWaiting} from '@/components/app-shell';
import {ConfirmDialog} from '@/components/confirm-dialog';
import {LiveHead} from '@/components/head';
import {Markdown} from '@/components/markdown';
import {type ModelChoice, ModelSwitcher} from '@/components/model-switcher';
import {PersonaDialog} from '@/components/persona-dialog';
import {Bubble, BubbleContent} from '@/components/chat/bubble';
import {
	InputGroup,
	InputGroupAddon,
	InputGroupButton,
	InputGroupTextarea,
} from '@proxy/ui/components/input-group';
import {Message, MessageContent} from '@/components/chat/message';
import {ConversationSearch} from '@/components/chat/conversation-search';
import {
	MessageScroller,
	MessageScrollerButton,
	MessageScrollerContent,
	MessageScrollerItem,
	MessageScrollerProvider,
	MessageScrollerViewport,
} from '@/components/chat/message-scroller';
import {Trace, TraceIcon, TraceLine, TraceTitle} from '@/components/chat/trace';
import {preview} from '@proxy/utils/harness';
import {cn} from '@proxy/ui/lib/utils';
import {useChatDraft} from '@/hooks/use-chat-draft';
import {useConversationSearch} from '@/hooks/use-conversation-search';
import {useLastLoaded, useLoaded} from '@/hooks/use-loaded';
import {useOrgSlug} from '@/hooks/use-org';
import {useReload} from '@/hooks/use-reload';
import {useReloadWhileHidden} from '@/hooks/use-reload-on-release';
import {useUnread} from '@/hooks/use-unread';
import {chatRuns} from '@/lib/chat-runs';
import {formatAgo, formatDateTime} from '@/lib/format';
import {describeFetchError} from '@/lib/loader-utils';
import type {chatLoader} from '@/loaders';
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuTrigger,
} from '@proxy/ui/components/context-menu';

// How often the log is read again while the agent is at work, and while it is not: a reply, or a
// wake-up, shows within a moment either way.
const BUSY_POLL_MS = 1000;
const IDLE_POLL_MS = 4000;
const CONVERSATION_LOG_ID = 'conversation-log';

// One turn of the conversation: what the person said in a dark bubble on the right (a light one
// in dark mode), as they typed it, or what the persona answered in a gray one on the left, as
// Markdown, in a red one where its turn failed. What it did in between, the sub-agents it started
// and what they said, is in the activity log, not here: this is a conversation.
function Turn({entry}: {entry: ChatEntry}) {
	if (entry.kind === 'person') {
		return (
			<Message align="end">
				<MessageContent>
					<Bubble align="end" variant="inverted">
						<BubbleContent data-search-whitespace="preserve" className="whitespace-pre-wrap">
							{entry.text}
						</BubbleContent>
					</Bubble>
				</MessageContent>
			</Message>
		);
	}
	return (
		<Message>
			<MessageContent>
				<Bubble variant={entry.isError ? 'destructive' : 'muted'}>
					<BubbleContent>
						<Markdown text={entry.text} />
					</BubbleContent>
				</Bubble>
			</MessageContent>
		</Message>
	);
}

// A stable callback ref keeps the search index from detaching and reattaching every turn whenever
// the conversation page renders for typing, polling or unread-state changes.
function SearchableTurn({
	entry,
	remember,
}: {
	entry: ChatEntry;
	remember: (entryId: string, element: HTMLDivElement | null) => void;
}) {
	const ref = useCallback(
		(element: HTMLDivElement | null) => remember(entry.id, element),
		[entry.id, remember],
	);
	return (
		<div ref={ref}>
			<Turn entry={entry} />
		</div>
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

// What the person typed in a conversation and hasn't sent, cut to a line; null without any.
function draftLine(draft: string | null): string | null {
	if (draft === null || draft.trim() === '') {
		return null;
	}
	return preview(draft);
}

// The last thing said in the open conversation, as the page has it, fresher than the list, cut
// to a line as the list has it.
function lastOf(log: ThreadLog): ChatPersona['lastMessage'] {
	const last = log.entries.at(-1);
	return last ? {kind: last.kind, text: preview(last.text), at: last.at} : null;
}

// When the persona was last active: the last thing said, or its making before anything was.
function lastActive(persona: ChatPersona, last: ChatPersona['lastMessage']): number {
	return Date.parse(last?.at ?? persona.createdAt);
}

// A conversation as the page shows it, fresher than the list: its log, and what is being typed.
type Shown = {personaId: string; log: ThreadLog; draft: string};

// The organization's personas in the second sidebar, each with its head, its name and the last
// thing said between it and the person, marked where the person hasn't seen it, or what they
// typed and haven't sent, the open one's as it is typed, the open one lit,
// each head watching the pointer while it is over that agent's row. The one last active is on
// top, the open one by its log, so what the person just said moves it up at once. It stays as it
// is from one conversation to the next: the one in the address is lit at once, while it loads.
function PersonaList({
	personas,
	current,
	shown,
	recallDraft,
	onOpen,
	onEdit,
	onDelete,
}: {
	personas: ChatPersona[];
	current: string;
	shown: Shown | null;
	recallDraft: (personaId: string) => string | null;
	onOpen: (personaId: string) => void;
	onEdit: (persona: ChatPersona) => void;
	onDelete: (persona: ChatPersona) => void;
}) {
	const org = useOrgSlug();
	const unread = useUnread();
	const [hovered, setHovered] = useState<string | null>(null);
	// Whether the persona said something the person hasn't seen, as the provider has it.
	const isUnread = (persona: ChatPersona) =>
		persona.id !== current && unread.unreadIds.has(persona.id);
	const rows = personas
		.map((persona) => {
			const open = shown?.personaId === persona.id ? shown : null;
			return {
				persona,
				last: open ? lastOf(open.log) : persona.lastMessage,
				draft: draftLine(open ? open.draft : (recallDraft(persona.id) ?? persona.draft)),
			};
		})
		.toSorted((a, b) => lastActive(b.persona, b.last) - lastActive(a.persona, a.last));
	return (
		<div className="flex h-full min-h-0 flex-col overflow-y-auto p-2">
			{personas.length === 0 && (
				<span className="px-2 py-1.5 text-sm text-muted-foreground">No agents yet.</span>
			)}
			<ul className="flex flex-col gap-0.5">
				{rows.map(({persona, last, draft}) => {
					const fresh = isUnread(persona);
					const row = (
						<Link
							to={`/${org}/chat/${persona.id}`}
							aria-current={persona.id === current ? 'page' : undefined}
							onClick={(event) => {
								if (
									event.button !== 0 ||
									event.metaKey ||
									event.ctrlKey ||
									event.shiftKey ||
									event.altKey
								) {
									return;
								}
								onOpen(persona.id);
							}}
							onPointerEnter={() => setHovered(persona.id)}
							onPointerLeave={() => setHovered(null)}
							className={cn(
								'flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
								persona.id === current && 'bg-sidebar-accent text-sidebar-accent-foreground',
							)}
						>
							<LiveHead
								look={persona.look}
								color={persona.color}
								size={40}
								watching={hovered === persona.id}
								tracking="head"
							/>
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
								<span className="flex items-center gap-2">
									<span
										className={cn(
											'min-w-0 flex-1 truncate text-xs',
											fresh ? 'font-medium' : 'text-muted-foreground',
										)}
									>
										{draft === null ? (
											subtitle(last)
										) : (
											<>
												<span className="font-medium text-foreground">Draft:</span> {draft}
											</>
										)}
									</span>
									{fresh && (
										<span
											role="status"
											aria-label="Unread"
											className="size-2 shrink-0 rounded-full bg-primary"
										/>
									)}
								</span>
							</span>
						</Link>
					);
					if (!persona.mayChange) {
						return <li key={persona.id}>{row}</li>;
					}
					return (
						<ContextMenu key={persona.id}>
							<ContextMenuTrigger render={<li />}>{row}</ContextMenuTrigger>
							<ContextMenuContent>
								<ContextMenuItem onClick={() => onEdit(persona)}>
									<PencilIcon />
									Edit
								</ContextMenuItem>
								<ContextMenuItem variant="destructive" onClick={() => onDelete(persona)}>
									<Trash2Icon />
									Delete
								</ContextMenuItem>
							</ContextMenuContent>
						</ContextMenu>
					);
				})}
			</ul>
		</div>
	);
}

// The page: the organization's agents beside the conversation with the one in its address. The
// list is the frame's, so moving to another conversation shows it at once, lit in the list and
// named in the header, while it loads; the conversation is started over as the address changes,
// so what one showed never lingers on another.
export function ChatPage() {
	const org = useOrgSlug();
	const navigate = useNavigate();
	const reload = useReload();
	const {id: current = ''} = useParams();
	// The agents as last listed, with each conversation as it loads.
	const listed = useLastLoaded<typeof chatLoader>();
	const personas = listed.answer?.personas ?? null;
	const name = personas?.find((persona) => persona.id === current)?.name;
	const [shown, setShown] = useState<Shown | null>(null);
	// The agent dialog: making a new one, or changing the selected one; closed as null.
	const [editing, setEditing] = useState<'new' | ChatPersona | null>(null);
	const [deleting, setDeleting] = useState<ChatPersona | null>(null);
	const [error, setError] = useState<string | null>(null);
	// A conversation picked in the list focuses its input once that conversation has loaded.
	// Nothing is requested on an ordinary page load, so it does not steal focus or open a phone's
	// keyboard just because the Chat page was visited.
	const [focusRequestedFor, setFocusRequestedFor] = useState<string | null>(null);
	// What was typed in each conversation while the page was open, fresher than the list, which
	// is read as another opens, perhaps before the save of what was typed in the last has landed.
	const drafts = useRef(new Map<string, string>());
	const recallDraft = useCallback((personaId: string) => drafts.current.get(personaId) ?? null, []);
	const rememberDraft = useCallback((personaId: string, text: string) => {
		drafts.current.set(personaId, text);
	}, []);

	// Saves the dialog's persona: a new one, opened; or the selected one, renamed or refaced.
	const savePersona = async (persona: Persona): Promise<string | null> => {
		if (editing === null) {
			return 'This agent is no longer being edited.';
		}
		if (editing === 'new') {
			const made = await createPersona(org, persona);
			if (made.isErr()) {
				return describeFetchError(made.error);
			}
			void navigate(`/${org}/chat/${made.value.persona.id}`);
			return null;
		}
		const changed = await updatePersona(org, editing.id, persona);
		if (changed.isErr()) {
			return describeFetchError(changed.error);
		}
		await reload();
		return null;
	};

	// Deletes a persona with everyone's conversations with it. If it was open, opens whichever is
	// first; otherwise refreshes the list around the conversation that stays open.
	const removePersona = async (persona: ChatPersona) => {
		const removed = await deletePersona(org, persona.id);
		if (removed.isErr()) {
			setError(describeFetchError(removed.error));
			return;
		}
		setError(null);
		if (persona.id === current) {
			void navigate(`/${org}/chat`);
			return;
		}
		await reload();
	};

	const title = () => {
		if (name !== undefined) {
			return <PageTitle>{name}</PageTitle>;
		}
		// A conversation not in the list once it has loaded, as one that could not be.
		return listed.pending ? <TitleWaiting /> : <PageTitle>Chat</PageTitle>;
	};

	const panel = () => {
		if (personas === null) {
			return listed.pending ? <PanelWaiting /> : null;
		}
		return (
			<PersonaList
				personas={personas}
				current={current}
				shown={shown}
				recallDraft={recallDraft}
				onOpen={setFocusRequestedFor}
				onEdit={setEditing}
				onDelete={setDeleting}
			/>
		);
	};

	return (
		<>
			<AppShell
				title={title()}
				actions={<AddButton label="New agent" onClick={() => setEditing('new')} />}
				panel={panel()}
				panelLabel="Agents"
				scroll="inside"
			>
				<OpenConversation
					recallDraft={recallDraft}
					rememberDraft={rememberDraft}
					onShown={setShown}
					managing={editing !== null || deleting !== null}
					listError={error}
					focusRequested={focusRequestedFor === current}
					onFocused={() => setFocusRequestedFor(null)}
				/>
			</AppShell>
			{editing !== null && (
				<PersonaDialog
					key={editing === 'new' ? 'new' : editing.id}
					open
					initial={
						editing === 'new'
							? null
							: {
									name: editing.name,
									look: editing.look,
									color: editing.color,
								}
					}
					onClose={() => setEditing(null)}
					onSave={savePersona}
					onDelete={
						editing !== 'new'
							? async () => {
									setDeleting(editing);
									return null;
								}
							: undefined
					}
				/>
			)}
			<ConfirmDialog
				open={deleting !== null}
				title={deleting ? `Delete ${deleting.name}?` : ''}
				description={
					deleting
						? `This deletes ${deleting.name} and every member's conversation with it. This cannot be undone.`
						: ''
				}
				confirmLabel="Delete"
				destructive
				onClose={() => setDeleting(null)}
				onConfirm={() => {
					if (!deleting) {
						return;
					}
					void removePersona(deleting);
				}}
			/>
		</>
	);
}

// What the page gives the conversation open in it.
type Opened = {
	recallDraft: (personaId: string) => string | null;
	rememberDraft: (personaId: string, text: string) => void;
	// The list beside the conversation shows it as the page does.
	onShown: (shown: Shown) => void;
	// An agent is being made, changed or deleted in a dialog.
	managing: boolean;
	// What deleting an agent from the list failed with.
	listError: string | null;
	// Whether this conversation was explicitly picked in the list and should take keyboard focus.
	focusRequested: boolean;
	onFocused: () => void;
};

// The conversation the address names, once loaded: started over when the address names another.
function OpenConversation(opened: Opened) {
	const {log, harnesses} = useLoaded<typeof chatLoader>();
	return <Conversation key={log.persona.id} loaded={log} harnesses={harnesses} {...opened} />;
}

// The person's conversation with one of the organization's personas: its log, read again as the
// persona works, and an input. The persona hands each piece of work to a sub-agent it keeps
// talking with, which acts as the person through the organization's built-in login, whose calls
// go through the same gate as any agent's, so its activity is in the log by the sub-agent's task.
function Conversation({
	loaded,
	harnesses,
	recallDraft,
	rememberDraft,
	onShown,
	managing,
	listError,
	focusRequested,
	onFocused,
}: Opened & {loaded: ThreadLog; harnesses: ChatHarness[]}) {
	const org = useOrgSlug();
	const reload = useReload();
	const [log, setLog] = useState<ThreadLog>(loaded);
	const personaId = loaded.persona.id;
	// What was typed and not sent, as the conversation opened: as this page left it, or as the
	// server keeps it. Read once: the log read again later says nothing of what is being typed.
	const [opening] = useState(() => {
		const kept = loaded.draft ?? '';
		return {kept, text: recallDraft(personaId) ?? kept};
	});
	const [text, setText] = useState(opening.text);
	const draft = useChatDraft(org, personaId, opening.kept);
	const [sending, setSending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const form = useRef<HTMLFormElement>(null);
	const input = useRef<HTMLTextAreaElement>(null);
	const current = loaded.persona;
	const {
		activeMatch: activeSearchMatch,
		changeQuery: changeSearchQuery,
		close: closeSearch,
		inputRef: searchInputRef,
		matchCount: searchMatchCount,
		matchesTruncated: searchMatchesTruncated,
		next: nextSearchMatch,
		open: searchOpen,
		overlayRef: searchOverlayRef,
		previous: previousSearchMatch,
		query: searchQuery,
		rememberEntryElement,
		viewportRef: conversationViewportRef,
	} = useConversationSearch(log.entries, managing);
	// What runs the persona, as the switcher shows it: the persona's, or what was just picked.
	const [runsOn, setRunsOn] = useState<ModelChoice>({
		harness: current.harness,
		chatModel: current.chatModel,
	});
	// A conversation is open all day: a new release is loaded while it is out of view, as long as
	// what is typed is saved as the draft and no dialog is open, since the log and the draft come
	// back from the server.
	useReloadWhileHidden(text === draft.saved && !sending && !managing);

	useEffect(() => {
		onShown({personaId, log, draft: text});
	}, [onShown, personaId, log, text]);

	useEffect(() => {
		if (!focusRequested || input.current === null) {
			return;
		}
		input.current.focus();
		onFocused();
	}, [focusRequested, onFocused]);

	// What this page had typed here that the server doesn't have yet, as it was left for another
	// conversation a moment before its save landed, is saved again.
	const {typed} = draft;
	useEffect(() => {
		if (opening.text !== opening.kept) {
			typed(opening.text);
		}
	}, [typed, opening]);

	const type = (value: string) => {
		setText(value);
		draft.typed(value);
		rememberDraft(personaId, value);
	};

	// Which read of the log was asked for last: one asked for before it that answers after it is
	// dropped, so a poll begun before a send can't put back the log as it was without the message.
	const latestRead = useRef(0);
	const readLog = useCallback(async () => {
		latestRead.current += 1;
		const read = latestRead.current;
		const result = await getThread(org, personaId);
		if (read !== latestRead.current || result.isErr()) {
			return;
		}
		setLog(result.value);
	}, [org, personaId]);

	// The log as it is now, while the page is open.
	useEffect(() => {
		const timer = setInterval(() => void readLog(), log.busy ? BUSY_POLL_MS : IDLE_POLL_MS);
		return () => {
			clearInterval(timer);
		};
	}, [readLog, log.busy]);

	// The provider is told which conversation the page shows, and its last answer: while the person
	// looks at it, it is neither counted nor notified of, and is read up to that answer.
	const lastAnswerId = log.entries.findLast((entry) => entry.kind === 'assistant')?.id ?? null;
	const {setViewing, answers} = useUnread();
	useEffect(() => {
		setViewing({personaId, answerId: lastAnswerId});
		return () => {
			setViewing(null);
		};
	}, [setViewing, personaId, lastAnswerId]);

	// The list's previews are read with the page: when another conversation's last answer changes,
	// as the provider asks every so often, the list is read again, so a row marked unread shows
	// what came rather than what was said before it. The open one's row shows the log.
	const answered =
		answers === null
			? null
			: answers
					.filter((answer) => answer.personaId !== personaId)
					.map((answer) => `${answer.personaId}:${answer.answer.id}`)
					.toSorted()
					.join(' ');
	const listedAnswers = useRef(answered);
	useEffect(() => {
		if (answered === null || listedAnswers.current === answered) {
			return;
		}
		const before = listedAnswers.current;
		listedAnswers.current = answered;
		if (before === null) {
			return;
		}
		void reload();
	}, [answered, reload]);

	// Switches what runs the persona, the harness and the model, from the input's switcher: shown
	// at once, kept with the persona as it is otherwise, and put back where the server refused it.
	const switchModel = async (choice: ModelChoice) => {
		const before = runsOn;
		setRunsOn(choice);
		setError(null);
		const changed = await updatePersona(org, personaId, {
			name: current.name,
			look: current.look,
			color: current.color,
			...choice,
		});
		if (changed.isErr()) {
			setRunsOn(before);
			setError(describeFetchError(changed.error));
			return;
		}
		await reload();
	};

	const send = async (event: FormEvent) => {
		event.preventDefault();
		const message = text.trim();
		if (message === '' || sending) {
			return;
		}
		setSending(true);
		setError(null);
		await draft.settle();
		const posted = await postMessage(org, personaId, message);
		setSending(false);
		if (posted.isErr()) {
			setError(describeFetchError(posted.error));
			draft.typed(text);
			return;
		}
		draft.sent();
		setText('');
		rememberDraft(personaId, '');
		await readLog();
	};

	// Enter sends; Shift+Enter breaks the line.
	const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
		if (event.key === 'Enter' && !event.shiftKey) {
			event.preventDefault();
			form.current?.requestSubmit();
		}
	};

	// Turns in a row from the same side sit closer together than the sides do, under the time
	// their stretch of the conversation began.
	const runs = chatRuns(log.entries, new Date());

	return (
		<>
			<div className="relative min-h-0 flex-1">
				{searchOpen && (
					<div className="absolute top-3 right-3 z-20 w-[calc(100%-1.5rem)] max-w-80">
						<ConversationSearch
							inputRef={searchInputRef}
							rootRef={searchOverlayRef}
							controlsId={CONVERSATION_LOG_ID}
							query={searchQuery}
							matchCount={searchMatchCount}
							matchesTruncated={searchMatchesTruncated}
							activeMatch={activeSearchMatch}
							onQueryChange={changeSearchQuery}
							onPrevious={previousSearchMatch}
							onNext={nextSearchMatch}
							onClose={closeSearch}
						/>
					</div>
				)}
				<MessageScrollerProvider autoScroll defaultScrollPosition="end">
					<MessageScroller>
						<MessageScrollerViewport
							ref={conversationViewportRef}
							id={CONVERSATION_LOG_ID}
							aria-label="Conversation"
						>
							<MessageScrollerContent className="page-column mx-auto w-full max-w-3xl pt-6 pb-4">
								{runs.length === 0 && (
									<div className="flex flex-1 flex-col items-center justify-center gap-2 py-12 text-center">
										<LiveHead look={current.look} color={current.color} size={64} />
										<p className="text-lg font-medium">What should {current.name} do?</p>
										<p className="max-w-md text-sm text-muted-foreground">
											This conversation is yours alone. {current.name} can use what is shared with
											everyone and what you connected yourself, as far as its access allows.
											Everything it does is in the activity log.
										</p>
									</div>
								)}
								{runs.map((run) => (
									<MessageScrollerItem
										key={run.entries[0]?.id}
										messageId={run.entries[0]?.id ?? ''}
										scrollAnchor={run.entries[0]?.kind === 'person'}
										className="flex flex-col gap-4"
									>
										{run.heading !== null && (
											<h2 className="text-center text-xs font-medium text-muted-foreground">
												{run.heading}
											</h2>
										)}
										<div className="flex flex-col gap-2">
											{run.entries.map((entry) => (
												<SearchableTurn
													key={entry.id}
													entry={entry}
													remember={rememberEntryElement}
												/>
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
			</div>
			<form
				ref={form}
				onSubmit={(event) => void send(event)}
				className="page-column mx-auto flex w-full max-w-3xl shrink-0 flex-col gap-2 pt-2 pb-4"
			>
				{(error ?? listError) && <p className="text-sm text-destructive">{error ?? listError}</p>}
				<InputGroup className="rounded-xl bg-background shadow-xs">
					<InputGroupTextarea
						ref={input}
						value={text}
						onChange={(event) => type(event.target.value)}
						onKeyDown={onKeyDown}
						placeholder={`Message ${current.name}`}
						aria-label="Message"
						className="min-h-10 p-3"
						rows={1}
					/>
					{/* The model's name starts where the message's hint does: 5px, the switcher's 1px border
					    and its 6px padding make the textarea's 12px. It sits on the send button's bottom. */}
					<InputGroupAddon align="block-end" className="items-end pl-[5px]">
						<ModelSwitcher
							harnesses={harnesses}
							chosen={runsOn}
							mayChange={current.mayChange}
							onPick={(choice) => void switchModel(choice)}
						/>
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
		</>
	);
}
