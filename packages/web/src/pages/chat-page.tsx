import type {
	ChatAttachment,
	ChatHarness,
	ChatPersona,
	ChatThread,
	ChatThreads,
	Persona,
	ThreadStanding,
	ThreadView,
} from '@proxy/contracts/harness';
import {Tooltip, TooltipContent, TooltipTrigger} from '@proxy/ui/components/tooltip';
import {
	ArchiveIcon,
	BotIcon,
	CheckIcon,
	Maximize2Icon,
	Minimize2Icon,
	PencilIcon,
	Trash2Icon,
	XIcon,
} from 'lucide-react';
import {
	memo,
	Suspense,
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from 'react';
import {Link, Outlet, useLocation, useNavigate, useParams} from 'react-router';
import {
	archiveThread,
	createPersona,
	deletePersona,
	markThreadDone,
	openThread,
	removeAttachment,
	updatePersona,
	uploadAttachment,
} from '@/client/harness-client';
import {AddButton} from '@/components/add-button';
import {
	AppShell,
	PageTitle,
	PanelWaiting,
	type Side,
	TitleWaiting,
	Waiting,
} from '@/components/app-shell';
import {Composer} from '@/components/chat/composer';
import {
	MessageScroller,
	MessageScrollerButton,
	MessageScrollerContent,
	MessageScrollerItem,
	MessageScrollerViewport,
} from '@/components/chat/message-scroller';
import {
	ARCHIVE_LABEL,
	ArchiveButton,
	DONE_LABEL,
	DoneButton,
	EventLine,
	PersonBubble,
	TitleBubble,
	ThreadStatus,
} from '@/components/chat/thread-parts';
import {ConfirmDialog} from '@/components/confirm-dialog';
import {LiveHead} from '@/components/head';
import {IconButton} from '@/components/icon-button';
import {PersonaDialog} from '@/components/persona-dialog';
import {ContentBoundary} from '@/components/route-error';
import {ATTACHMENT_MARK, preview} from '@proxy/utils/harness';
import {RewriteText} from '@/components/chat/rewrite-text';
import {cn} from '@proxy/ui/lib/utils';
import type {AttachmentInput} from '@/hooks/use-attachments';
import {useChatDraft} from '@/hooks/use-chat-draft';
import {FROM_COMMAND_BAR} from '@/lib/command-bar';
import {useLastLoaded, useLoaded} from '@/hooks/use-loaded';
import {rememberedPersonaList} from '@/lib/persona-list';
import {useInView} from '@/hooks/use-in-view';
import {useListMotion} from '@/hooks/use-list-motion';
import {useOrgSlug} from '@/hooks/use-org';
import {usePoll} from '@/hooks/use-poll';
import {useReload} from '@/hooks/use-reload';
import {useSending} from '@/hooks/use-sending';
import {useUnread} from '@/hooks/use-unread';
import {formatMessageTime} from '@/lib/chat-time';
import {formatAgo} from '@/lib/format';
import {describeApiError, describeFetchError} from '@/lib/loader-utils';
import type {chatLoader} from '@/loaders';
import type {ThreadContext} from '@/pages/chat-thread';
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuTrigger,
} from '@proxy/ui/components/context-menu';

// How often the chat is read again while a thread of it is in progress, so one that stops, or
// answers, shows within a moment; and how long after the last read the page coming back into view
// reads it again.
const IN_PROGRESS_POLL_MS = 4000;
const IN_PROGRESS_VISIBLE_GAP_MS = 2000;

// The band behind the thread open beside the chat, the width of the chat.
const OPEN_BAND = 'bg-[color-mix(in_srgb,var(--muted)_55%,var(--background))]';

type LastMessage = ChatPersona['lastMessage'];

// What a row shows under the name: the last thing said in the chat, the person's with "You:".
function subtitle(last: LastMessage): string {
	if (last === null) {
		return 'Nothing yet';
	}
	return last.kind === 'person' ? `You: ${last.text}` : last.text;
}

// What the person typed in a chat and hasn't sent, cut to a line; null without any.
function draftLine(draft: string | null): string | null {
	if (draft === null || draft.trim() === '') {
		return null;
	}
	return preview(draft);
}

// The latest of what the page knows was said last, as the list has it and as the page shows it.
function latestOf(candidates: LastMessage[]): LastMessage {
	return candidates.reduce<LastMessage>((latest, candidate) => {
		if (candidate === null) {
			return latest;
		}
		if (latest === null || Date.parse(candidate.at) > Date.parse(latest.at)) {
			return candidate;
		}
		return latest;
	}, null);
}

// The last thing said in a thread, as it is shown, cut to a line as the list has it.
function lastOfThread(view: ThreadView | null): LastMessage {
	const last = view?.messages.findLast(
		(message) => message.kind === 'person' || message.kind === 'assistant',
	);
	if (last === undefined || last.kind === 'event') {
		return null;
	}
	return {kind: last.kind, text: preview(last.text), at: last.at};
}

// When the persona was last active: the last thing said, or its making before anything was.
function lastActive(persona: ChatPersona, last: LastMessage): number {
	return Date.parse(last?.at ?? persona.createdAt);
}

// The open chat as the page shows it, fresher than the list: what the person said last in it from
// here, and what is typed in it.
type ShownSaid = {personaId: string; last: LastMessage};
type ShownDraft = {personaId: string; draft: string};
type Shown = {personaId: string; last: LastMessage; draft: string};

// The personas the person sees, their own and General, in the sidebar, each with its head, its
// name and the last thing said between it and the person, marked where the person hasn't seen it,
// or what they typed and haven't sent, the open one's as it is typed, the open one lit, each head
// watching the pointer while it is over that agent's row. The one last active is on top, the open
// one by what the page shows of it, so what the person just said moves it up at once. It stays as
// it is from one chat to the next: the one in the address is lit at once, while it loads. A row
// that comes, goes or changes places moves there (`useListMotion`): an agent made, deleted or
// moved up by what was said. At the column's foot, below the agents however many, the button that
// makes a new agent.
function PersonaList({
	personas,
	current,
	shown,
	recallDraft,
	onOpen,
	onNew,
	onEdit,
	onDelete,
}: {
	personas: ChatPersona[];
	current: string;
	shown: Shown | null;
	recallDraft: (personaId: string) => string | null;
	onOpen: (personaId: string) => void;
	onNew: () => void;
	onEdit: (persona: ChatPersona) => void;
	onDelete: (persona: ChatPersona) => void;
}) {
	const org = useOrgSlug();
	const unread = useUnread();
	const [hovered, setHovered] = useState<string | null>(null);
	const list = useListMotion<HTMLDivElement>();
	// Whether the persona said something the person hasn't seen, as the provider has it.
	const isUnread = (persona: ChatPersona) =>
		persona.id !== current && unread.unreadIds.has(persona.id);
	const rows = personas
		.map((persona) => {
			const open = shown?.personaId === persona.id ? shown : null;
			return {
				persona,
				last: open ? latestOf([persona.lastMessage, open.last]) : persona.lastMessage,
				draft: draftLine(open ? open.draft : (recallDraft(persona.id) ?? persona.draft)),
			};
		})
		.toSorted((a, b) => lastActive(b.persona, b.last) - lastActive(a.persona, a.last));
	return (
		<div className="flex h-full min-h-0 flex-col">
			{/* Right under the sidebar's way back up, as close as the rows are to each other. */}
			<div
				ref={list}
				className="relative flex min-h-0 flex-1 flex-col overflow-y-auto px-2 pt-0.5 pb-2"
			>
				{personas.length === 0 && (
					<span className="px-2 py-1.5 text-sm text-muted-foreground">No agents yet.</span>
				)}
				<ul className="flex flex-col gap-0.5">
					{rows.map(({persona, last, draft}) => {
						const fresh = isUnread(persona);
						const lit = persona.id === current;
						const row = (
							<Link
								to={`/${org}/chat/${persona.id}`}
								aria-current={lit ? 'page' : undefined}
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
								className={cn(
									'flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
									lit && 'bg-sidebar-accent text-sidebar-accent-foreground',
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
						return (
							<li
								key={persona.id}
								data-row={persona.id}
								onPointerEnter={() => setHovered(persona.id)}
								onPointerLeave={() => setHovered(null)}
							>
								{persona.mayChange ? (
									<ContextMenu>
										<ContextMenuTrigger render={<div />}>{row}</ContextMenuTrigger>
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
								) : (
									row
								)}
							</li>
						);
					})}
				</ul>
			</div>
			<div className="flex shrink-0 p-2">
				<AddButton label="New agent" variant="ghost" onClick={onNew} className="w-full" />
			</div>
		</div>
	);
}

// The open thread's name in the title bar, with where it stands while in progress or waiting for
// the person (once done, its name alone): what stands for it while it loads, and a plain word for
// one the chat doesn't have, whose name will not come.
function ThreadName({
	thread,
	standing,
	missing,
}: {
	thread: ChatThread | null;
	standing: ThreadStanding | null;
	missing: boolean;
}) {
	if (thread === null) {
		return missing ? <span className="text-sm font-medium">Thread</span> : <TitleWaiting />;
	}
	return (
		<>
			<span className="min-w-0 truncate text-sm font-medium">
				<RewriteText text={thread.title || 'Thread'} />
			</span>
			{standing !== null && standing !== 'done' && <ThreadStatus standing={standing} />}
		</>
	);
}

// The open thread's cell of the title bar: its name (`ThreadName`), and, at the right, the
// check that says it is done where it waits for the person, or, once done, the button that archives
// it, and the buttons that give it the page's width and back, and close it.
function ThreadHeader({
	thread,
	standing,
	missing,
	expanded,
	onExpand,
	onDone,
	onArchive,
	closeTo,
}: {
	thread: ChatThread | null;
	standing: ThreadStanding | null;
	// The address names a thread the chat doesn't have.
	missing: boolean;
	expanded: boolean;
	onExpand: () => void;
	onDone: (thread: ChatThread) => void;
	onArchive: (thread: ChatThread) => void;
	closeTo: string;
}) {
	return (
		<>
			<ThreadName thread={thread} standing={standing} missing={missing} />
			<span className="flex-1" />
			{thread !== null && standing === 'waiting' && (
				<IconButton label={DONE_LABEL} onClick={() => onDone(thread)}>
					<CheckIcon className="size-4" />
				</IconButton>
			)}
			{thread !== null && standing === 'done' && (
				<IconButton label={ARCHIVE_LABEL} onClick={() => onArchive(thread)}>
					<ArchiveIcon className="size-4" />
				</IconButton>
			)}
			{/* On a narrow window the thread always has the page's width. */}
			<span className="flex max-lg:hidden">
				<IconButton label={expanded ? 'Show the chat beside it' : 'Expand'} onClick={onExpand}>
					{expanded ? <Minimize2Icon className="size-4" /> : <Maximize2Icon className="size-4" />}
				</IconButton>
			</span>
			<IconButton label="Close" to={closeTo}>
				<XIcon className="size-4" />
			</IconButton>
		</>
	);
}

// The page: the organization's agents in the sidebar, beside the person's chat with the one in its
// address, a list of its threads, and the thread the address names open beside it (pages/
// chat-thread.tsx). The list of agents is the frame's, so moving to another chat shows it at once,
// lit in the list and named in the header, while it loads; the chat is started over as the agent
// in the address changes, so what one showed never lingers on another, and stays as it is as a
// thread of it opens and closes.
export function ChatPage() {
	const org = useOrgSlug();
	const navigate = useNavigate();
	const reload = useReload();
	const {id: current = '', threadId} = useParams();
	// The agents as last listed, with each chat as it loads; until the first has, as the list last
	// came anywhere (lib/persona-list.ts), so they are there as the page opens.
	const listed = useLastLoaded<typeof chatLoader>();
	const list = listed.answer ?? rememberedPersonaList(org);
	const personas = list?.personas ?? null;
	const name = personas?.find((persona) => persona.id === current)?.name;
	const [shownSaid, setShownSaid] = useState<ShownSaid | null>(null);
	const [shownDraft, setShownDraft] = useState<ShownDraft | null>(null);
	const [shownThreads, setShownThreads] = useState<ChatThread[]>([]);
	// The thread open beside the chat, as it shows it.
	const [shownThread, setShownThread] = useState<ThreadView | null>(null);
	// The thread given the page's width, by its id, until it is given the chat back or closed, as
	// it is once the address names it no more: opened again, it is beside the chat.
	const [expanded, setExpanded] = useState<string | null>(null);
	if (expanded !== null && expanded !== threadId) {
		setExpanded(null);
	}
	// Whether the address names a thread the chat doesn't have, as the thread's place says.
	const [threadMissing, setThreadMissing] = useState(false);
	// The agent dialog: making a new one, or changing the selected one; closed as null.
	const [editing, setEditing] = useState<'new' | ChatPersona | null>(null);
	const [deleting, setDeleting] = useState<ChatPersona | null>(null);
	const [error, setError] = useState<string | null>(null);
	// The threads the person said are done here, each by its id with when it last had a message
	// then: until something more is said in it, it is done on the page, whatever a read from before
	// the server had it says.
	const [markedDone, setMarkedDone] = useState<ReadonlyMap<string, string>>(() => new Map());
	const standingOf = useCallback(
		(thread: ChatThread): ThreadStanding =>
			thread.standing === 'waiting' && markedDone.get(thread.id) === thread.lastMessageAt
				? 'done'
				: thread.standing,
		[markedDone],
	);
	// Says a thread waiting for the person is done, on the page at once and then on the server;
	// where the server can't be told, it waits again, and the chat's box says why.
	const markDone = useCallback(
		async (thread: ChatThread) => {
			setMarkedDone((before) => new Map(before).set(thread.id, thread.lastMessageAt));
			const marked = await markThreadDone(org, current, thread.id);
			if (marked.isOk()) {
				setError(null);
				return;
			}
			setMarkedDone((before) => {
				const after = new Map(before);
				after.delete(thread.id);
				return after;
			});
			setError(describeFetchError(marked.error));
		},
		[org, current],
	);
	// The threads the person archived here, each by its id with when it last had a message then:
	// until something more comes into it, it is out of the chat's list on the page, as it is out of
	// the server's once the server has it, which brings it back as something comes.
	const [archived, setArchived] = useState<ReadonlyMap<string, string>>(() => new Map());
	const isArchived = useCallback(
		(thread: ChatThread): boolean => archived.get(thread.id) === thread.lastMessageAt,
		[archived],
	);
	// Archives a thread, on the page at once and then on the server; where the server can't be
	// told, it is back in the list, and the chat's box says why.
	const archive = useCallback(
		async (thread: ChatThread) => {
			setArchived((before) => new Map(before).set(thread.id, thread.lastMessageAt));
			const done = await archiveThread(org, current, thread.id);
			if (done.isOk()) {
				setError(null);
				return;
			}
			setArchived((before) => {
				const after = new Map(before);
				after.delete(thread.id);
				return after;
			});
			setError(describeFetchError(done.error));
		},
		[org, current],
	);
	// A chat picked in the list, or in the command bar, focuses its box once that chat has loaded.
	// Nothing is requested on an ordinary page load, so it does not steal focus or open a phone's
	// keyboard just because the Chat page was visited.
	const location = useLocation();
	const fromBar = location.state === FROM_COMMAND_BAR;
	const [focusRequestedFor, setFocusRequestedFor] = useState<string | null>(
		fromBar ? current : null,
	);
	// The bar can go to a chat while the page is up, as from another one.
	const [arrival, setArrival] = useState(location.key);
	if (arrival !== location.key) {
		setArrival(location.key);
		if (fromBar) {
			setFocusRequestedFor(current);
		}
	}
	const focused = useCallback(() => setFocusRequestedFor(null), [setFocusRequestedFor]);
	// What was typed in each chat while the page was open, fresher than the list, which is read as
	// another opens, perhaps before the save of what was typed in the last has landed.
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

	// Deletes a persona with the chats with it: the person's, and for one every member sees,
	// everyone's. If it was open, opens whichever is first; otherwise refreshes the list around the
	// chat that stays open.
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

	// The open chat in the list as the page shows it, fresher than the list while the list is the
	// one loaded with it: what was said last in it here and in its open thread, and what is typed.
	const shown: Shown | null =
		listed.answer !== null && shownDraft?.personaId === current
			? {
					personaId: current,
					last: latestOf([
						shownSaid?.personaId === current ? shownSaid.last : null,
						shownThread?.persona.id === current ? lastOfThread(shownThread) : null,
					]),
					draft: shownDraft.draft,
				}
			: null;

	// The thread open beside the chat as the title bar names it: as it shows itself, or, while it
	// loads, as the chat lists it, so its name is there as it is opened.
	const openThread =
		threadId === undefined
			? null
			: shownThread?.thread.id === threadId
				? shownThread.thread
				: (shownThreads.find((thread) => thread.id === threadId) ?? null);
	const chatTo = `/${org}/chat/${current}`;
	// The thread open beside the chat closes as it is archived.
	const openArchived = openThread !== null && isArchived(openThread);
	useEffect(() => {
		if (openArchived) {
			void navigate(chatTo);
		}
	}, [openArchived, navigate, chatTo]);
	const full = threadId !== undefined && expanded === threadId;
	const context: ThreadContext = {
		harnesses: list?.harnesses ?? [],
		managing: editing !== null || deleting !== null,
		onShown: setShownThread,
		onMissing: setThreadMissing,
	};
	const side: Side | undefined =
		threadId === undefined
			? undefined
			: {
					full,
					header: (
						<ThreadHeader
							thread={openThread}
							standing={openThread === null ? null : standingOf(openThread)}
							missing={threadMissing}
							expanded={full}
							onExpand={() => setExpanded(full ? null : threadId)}
							onDone={markDone}
							onArchive={archive}
							closeTo={chatTo}
						/>
					),
					content: (
						// Each thread its own, and its own failure, while the chat stays as it is.
						<Suspense key={threadId} fallback={<Waiting column />}>
							<ContentBoundary key={threadId}>
								<Outlet context={context} />
							</ContentBoundary>
						</Suspense>
					),
				};

	const title = () => {
		if (name !== undefined) {
			return <PageTitle>{name}</PageTitle>;
		}
		// A chat not in the list once it has loaded, as one that could not be.
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
				onNew={() => setEditing('new')}
				onEdit={setEditing}
				onDelete={setDeleting}
			/>
		);
	};

	return (
		<>
			<AppShell
				title={title()}
				panel={panel()}
				panelLabel="Chat"
				scroll="inside"
				contentKey={current}
				side={side}
			>
				<OpenChat
					openThread={shownThread?.persona.id === current ? shownThread : null}
					threadId={threadId ?? null}
					recallDraft={recallDraft}
					rememberDraft={rememberDraft}
					onShownSaid={setShownSaid}
					onShownDraft={setShownDraft}
					onShownThreads={setShownThreads}
					standingOf={standingOf}
					onDone={markDone}
					isArchived={isArchived}
					onArchive={archive}
					managing={editing !== null || deleting !== null}
					listError={error}
					focusRequested={focusRequestedFor === current}
					onFocused={focused}
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
						? `This deletes ${deleting.name} and ${deleting.shared ? "every member's" : 'your'} conversation with it. This cannot be undone.`
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

// What the page gives the chat open in it.
type Opened = {
	// The thread open beside the chat, as it shows it, fresher than the list; and its id, from the
	// address, before it has loaded.
	openThread: ThreadView | null;
	threadId: string | null;
	recallDraft: (personaId: string) => string | null;
	rememberDraft: (personaId: string, text: string) => void;
	// The list beside the chat shows it as the page does: what the person said in it last, and what
	// is typed in it; the title bar names the thread open beside it as the chat lists it.
	onShownSaid: (shown: ShownSaid) => void;
	onShownDraft: (shown: ShownDraft) => void;
	onShownThreads: (threads: ChatThread[]) => void;
	// Where a thread stands on the page, the person's Done taken in, and saying it is done.
	standingOf: (thread: ChatThread) => ThreadStanding;
	onDone: (thread: ChatThread) => void;
	// Whether the person archived a thread on the page, which the list leaves out, and archiving one.
	isArchived: (thread: ChatThread) => boolean;
	onArchive: (thread: ChatThread) => void;
	// An agent is being made, changed or deleted in a dialog.
	managing: boolean;
	// What deleting an agent from the list failed with.
	listError: string | null;
	// Whether this chat was explicitly picked in the list and should take keyboard focus.
	focusRequested: boolean;
	onFocused: () => void;
};

// The chat the address names, once loaded: started over when the address names another agent.
function OpenChat(opened: Opened) {
	const {chat, harnesses} = useLoaded<typeof chatLoader>();
	return <Chat key={chat.persona.id} loaded={chat} harnesses={harnesses} {...opened} />;
}

// What the person said in the chat to open a thread; null for a thread something else opened.
function openerText(thread: ChatThread): string | null {
	return thread.opener?.kind === 'person' ? thread.opener.text : null;
}

// What opened a thread: what the person said, or the event that came into it. Once the thread has
// a title written from what they said, the title stands for it, rewritten there from what they
// said where that was shown before; the thread keeps what they said as they said it.
function Opener({
	opener,
	title,
	open,
}: {
	opener: ChatThread['opener'];
	title: string | null;
	open: boolean;
}) {
	// What the person's bubble showed last before the title came, to rewrite it from.
	const [said, setSaid] = useState<string | null>(null);
	const plain =
		opener?.kind === 'person' && title === null
			? opener.text.replaceAll(ATTACHMENT_MARK, ' ').replace(/\s+/g, ' ').trim()
			: null;
	if (plain !== null && plain !== said) {
		setSaid(plain);
	}
	if (opener === null) {
		return null;
	}
	if (opener.kind === 'event') {
		return <EventLine text={opener.text} />;
	}
	if (title === null) {
		return <PersonBubble text={opener.text} attachments={opener.attachments} outlined={open} />;
	}
	return <TitleBubble title={title} from={said} attachments={opener.attachments} outlined={open} />;
}

// One thread in the chat, opening it beside the chat: where it stands, what opened it, where it
// stands in a sentence, or, without a current one, the start of the latest thing the persona said
// in it, how many messages it holds with when the last came, and, where it waits for the person,
// the check after that which says it is done, or, once it is done, the button that archives it. The one open has a band behind it, the width of the chat. The
// whole of it is a link, under what it shows, so the files in what opened it are still links of
// their own, and the button is a button, opening nothing; one just sent, which the server has yet
// to open, has no address to link to (`to` null), and opens nothing until it has. It is drawn
// again only as it changes; one that came while the chat was open rises into place.
const ThreadItem = memo(function ThreadItem({
	thread,
	to,
	open,
	fresh,
	onDone,
	onArchive,
	rowRef,
}: {
	thread: ChatThread;
	to: string | null;
	open: boolean;
	fresh: boolean;
	onDone: (thread: ChatThread) => void;
	onArchive: (thread: ChatThread) => void;
	// Given the row's element where the chat wants to know whether it is in view.
	rowRef?: (row: HTMLDivElement | null) => void;
}) {
	const said = thread.summary ?? thread.latest;
	const count = `${thread.messageCount} ${thread.messageCount === 1 ? 'message' : 'messages'}`;
	return (
		<div
			ref={rowRef}
			data-enter={fresh ? 'rise' : undefined}
			className={cn('relative py-5.5', open && OPEN_BAND)}
		>
			{to !== null && (
				<Link
					to={to}
					aria-label={thread.title || 'Thread'}
					aria-current={open ? 'page' : undefined}
					className="absolute inset-0 outline-none focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset"
				/>
			)}
			<div className="page-column pointer-events-none relative mx-auto flex w-full max-w-4xl flex-col items-start gap-2.5 [&_a]:pointer-events-auto [&_button]:pointer-events-auto">
				<ThreadStatus standing={thread.standing} />
				<Opener opener={thread.opener} title={thread.titled ? thread.title : null} open={open} />
				{said !== null && (
					<p className="line-clamp-2 max-w-[44rem] text-sm leading-relaxed">
						<RewriteText text={said} />
					</p>
				)}
				<div className="flex h-5 items-center gap-1">
					{thread.startedByAgent && <StartedByAgent />}
					<p className="text-xs text-muted-foreground">
						{count} · {formatMessageTime(thread.lastMessageAt)}
					</p>
					{thread.standing === 'waiting' && <DoneButton onDone={() => onDone(thread)} />}
					{thread.standing === 'done' && <ArchiveButton onArchive={() => onArchive(thread)} />}
				</div>
			</div>
		</div>
	);
});

// The mark of a thread the agent of another thread started, not the person: a robot, which says
// so when hovered or focused.
function StartedByAgent() {
	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<span
						tabIndex={0}
						aria-label="This was started from another thread"
						className="pointer-events-auto inline-flex text-muted-foreground outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
					/>
				}
			>
				<BotIcon className="size-3.5" />
			</TooltipTrigger>
			<TooltipContent>This was started from another thread</TooltipContent>
		</Tooltip>
	);
}

// The threads in the order the chat lists them, by when each last had a message, the last last,
// those the page has fresher in their place.
function inOrder(threads: ChatThread[], fresher: ChatThread | null): ChatThread[] {
	const shown =
		fresher === null
			? threads
			: threads.map((thread) => (thread.id === fresher.id ? fresher : thread));
	return shown.toSorted((a, b) => Date.parse(a.lastMessageAt) - Date.parse(b.lastMessageAt));
}

// The person's chat with one of the personas they see: its threads, read again while one of them
// is in progress, and a box, whose every message opens a thread, which shows at once at the
// chat's end, before the server has it. Each thread's agent acts as the person through the
// organization's built-in login, whose calls go through the same gate as any agent's, so its
// activity is in the log by the thread's task.
const Chat = memo(function Chat({
	loaded,
	harnesses,
	openThread: fresher,
	threadId,
	recallDraft,
	rememberDraft,
	onShownSaid,
	onShownDraft,
	onShownThreads,
	standingOf,
	onDone,
	isArchived,
	onArchive,
	managing,
	listError,
	focusRequested,
	onFocused,
}: Opened & {loaded: ChatThreads; harnesses: ChatHarness[]}) {
	const org = useOrgSlug();
	const reload = useReload();
	const personaId = loaded.persona.id;
	const current = loaded.persona;
	const sending = useSending(loaded.threads, openerText);
	const threads = useMemo(
		() =>
			inOrder(sending.entries, fresher?.thread ?? null).flatMap((thread) => {
				if (isArchived(thread)) {
					return [];
				}
				const standing = standingOf(thread);
				return [standing === thread.standing ? thread : {...thread, standing}];
			}),
		[sending.entries, fresher, standingOf, isArchived],
	);
	// What the chat had as it opened: what comes after it rises into place.
	const [opened] = useState(() => new Set(loaded.threads.map((thread) => thread.id)));

	useLayoutEffect(() => {
		onShownThreads(threads);
	}, [onShownThreads, threads]);

	// The chat read again every so often while a thread of it is in progress, so one that stops,
	// or says something, shows; and while where one that stopped stands is still being read, which
	// is written a moment after it stops, so that it shows as waiting for the person, with its
	// sentence, rather than as done.
	const reloadChat = useCallback(() => void reload(), [reload]);
	usePoll(reloadChat, {
		enabled: threads.some((thread) => thread.state.kind !== 'stopped' || thread.standingPending),
		intervalMs: IN_PROGRESS_POLL_MS,
		visibleGapMs: IN_PROGRESS_VISIBLE_GAP_MS,
		immediate: false,
	});

	// The persona's last answer in the chat, as the provider last asked, is shown where it is a
	// listed thread's latest answer and that thread's row is in view, which it isn't while a thread
	// has the page's width, as on a narrow window, or scrolled out of the list; or among what the
	// open thread says. The provider is told which chat the page shows, and that answer once it is
	// shown: while the person looks at it, it is neither counted nor notified of, and is read up to
	// that answer.
	const {setViewing, answers} = useUnread();
	const answer = answers?.find((candidate) => candidate.personaId === personaId)?.answer ?? null;
	const [answerRow, setAnswerRow] = useState<HTMLDivElement | null>(null);
	const answerRowInView = useInView(answerRow);
	const answerShown =
		answer !== null &&
		((answerRowInView && threads.some((thread) => thread.latestAnswerId === answer.id)) ||
			(fresher?.messages.some((message) => message.id === answer.id) ?? false));
	const answerId = answerShown ? answer.id : null;
	useEffect(() => {
		setViewing({personaId, answerId});
		return () => {
			setViewing(null);
		};
	}, [setViewing, personaId, answerId]);

	// The list is read with the page: when a chat's last answer changes, as the provider asks every
	// so often, the list is read again, so the thread it came in says it here, and a row marked
	// unread in the list of agents shows what came rather than what was said before it.
	const answered =
		answers === null
			? null
			: answers
					.map((one) => `${one.personaId}:${one.answer.id}`)
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

	// Opens a thread with what the person wrote, with the files placed among it, shown at once and
	// taken away again where the send fails, once `settle` has: what it failed with, or null.
	const send = async (
		message: string,
		files: ChatAttachment[],
		settle: () => Promise<void>,
	): Promise<string | null> => {
		const key = `sending-${crypto.randomUUID()}`;
		const at = new Date().toISOString();
		sending.start({
			id: key,
			title: preview(message),
			state: {kind: 'working'},
			standing: 'in_progress',
			standingPending: false,
			opener: {kind: 'person', text: message, attachments: files},
			summary: null,
			latest: null,
			latestEntryId: null,
			latestAnswerId: null,
			startedByAgent: false,
			titled: false,
			messageCount: 1,
			lastMessageAt: at,
		});
		onShownSaid({personaId, last: {kind: 'person', text: preview(message), at}});
		await settle();
		const posted = await openThread(org, personaId, message, files);
		if (posted.isErr()) {
			sending.failed(key);
			onShownSaid({personaId, last: null});
			return describeApiError(posted.error);
		}
		sending.posted(key, posted.value.thread.id);
		await reload();
		return null;
	};

	return (
		<>
			<MessageScroller className="min-h-0 flex-1">
				<MessageScrollerViewport aria-label="Chat">
					<MessageScrollerContent className="w-full gap-3.5 pt-2 pb-4">
						{threads.length === 0 && (
							<div className="page-column flex flex-1 flex-col items-center justify-center gap-2 py-12 text-center">
								<LiveHead look={current.look} color={current.color} size={64} />
								<p className="text-lg font-medium">What should {current.name} do?</p>
								<p className="max-w-md text-sm text-muted-foreground">
									This conversation is yours alone. Each message opens a thread of its own, where{' '}
									{current.name} works on it and answers you. It can use what is shared with
									everyone and what you connected yourself, as far as its access allows. Everything
									it does is in the activity log.
								</p>
							</div>
						)}
						{threads.map((thread) => {
							const key = sending.keyOf(thread);
							// One just sent is the server's once the send has answered, before the chat
							// read again has it.
							const id = sending.idOf(thread);
							return (
								<MessageScrollerItem key={key} scrollAnchor={sending.sentHere(thread)}>
									<ThreadItem
										thread={thread}
										to={id === null ? null : `/${org}/chat/${personaId}/threads/${id}`}
										open={id !== null && id === threadId}
										fresh={!opened.has(key)}
										onDone={onDone}
										onArchive={onArchive}
										rowRef={
											answer !== null && thread.latestAnswerId === answer.id
												? setAnswerRow
												: undefined
										}
									/>
								</MessageScrollerItem>
							);
						})}
					</MessageScrollerContent>
				</MessageScrollerViewport>
				<MessageScrollerButton />
			</MessageScroller>
			<ChatComposer
				persona={current}
				kept={loaded.draft ?? ''}
				keptFiles={loaded.draftAttachments}
				harnesses={harnesses}
				recallDraft={recallDraft}
				rememberDraft={rememberDraft}
				onShownDraft={onShownDraft}
				managing={managing}
				takesDrops={threadId === null}
				listError={listError}
				focusRequested={focusRequested}
				onFocused={onFocused}
				onSend={send}
			/>
		</>
	);
});

// The box under the chat, which opens a thread with every message: what is typed in it is kept on
// the server as the chat's draft, and so are the files put in it, so it opens as it was left, on
// any device.
function ChatComposer({
	persona,
	kept,
	keptFiles,
	harnesses,
	recallDraft,
	rememberDraft,
	onShownDraft,
	managing,
	takesDrops,
	listError,
	focusRequested,
	onFocused,
	onSend,
}: Pick<
	Opened,
	| 'recallDraft'
	| 'rememberDraft'
	| 'onShownDraft'
	| 'managing'
	| 'listError'
	| 'focusRequested'
	| 'onFocused'
> & {
	persona: ChatPersona;
	// The draft the server keeps, as the chat opened, and the files in its box.
	kept: string;
	keptFiles: ChatAttachment[];
	harnesses: ChatHarness[];
	takesDrops: boolean;
	onSend: (
		message: string,
		files: ChatAttachment[],
		settle: () => Promise<void>,
	) => Promise<string | null>;
}) {
	const org = useOrgSlug();
	const personaId = persona.id;
	const input = useMemo(
		(): AttachmentInput => ({
			upload: (file) => uploadAttachment(org, personaId, file),
			remove: (attachment) => void removeAttachment(org, personaId, attachment),
		}),
		[org, personaId],
	);
	// What was typed and not sent, as the chat opened: as this page left it, or as the server keeps
	// it. Read once: the chat read again later says nothing of what is being typed.
	const [opening] = useState(() => ({kept, text: recallDraft(personaId) ?? kept}));
	const draft = useChatDraft(org, personaId, opening.kept);

	// What this page had typed here that the server doesn't have yet, as it was left for another
	// chat a moment before its save landed, is saved again.
	const {typed} = draft;
	useEffect(() => {
		if (opening.text !== opening.kept) {
			typed(opening.text);
		}
	}, [typed, opening]);

	const onTyped = useCallback(
		(text: string) => rememberDraft(personaId, text),
		[rememberDraft, personaId],
	);
	const onWaiting = useCallback(
		(waiting: string) => onShownDraft({personaId, draft: waiting}),
		[onShownDraft, personaId],
	);

	return (
		<Composer
			persona={persona}
			harnesses={harnesses}
			label="Message"
			placeholder={`Start a new thread with ${persona.name}`}
			input={input}
			keptFiles={keptFiles}
			openingText={opening.text}
			kept={draft}
			onTyped={onTyped}
			onWaiting={onWaiting}
			managing={managing}
			takesDrops={takesDrops}
			otherError={listError}
			focusRequested={focusRequested}
			onFocused={onFocused}
			onSend={onSend}
			className="page-column mx-auto max-w-4xl"
		/>
	);
}
