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
import {ArchiveIcon, CheckIcon, ChevronLeftIcon, PencilIcon, Trash2Icon} from 'lucide-react';
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
import {Link, useLocation, useNavigate, useParams, useRouteLoaderData} from 'react-router';
import {
	archiveThread,
	createPersona,
	deletePersona,
	markThreadDone,
	openThread,
	renameThread,
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
import {Composer, type ComposerModel} from '@/components/chat/composer';
import {
	AlertsLine,
	ARCHIVE_LABEL,
	ArchiveButton,
	DONE_LABEL,
	DoneButton,
	ThreadStatus,
	ThreadStatusIcon,
} from '@/components/chat/thread-parts';
import {ConfirmDialog} from '@/components/confirm-dialog';
import {Dialog, DialogContent, DialogTitle} from '@proxy/ui/components/dialog';
import {LiveHead} from '@/components/head';
import {IconButton} from '@/components/icon-button';
import {PersonaDialog} from '@/components/persona-dialog';
import {ContentBoundary} from '@/components/route-error';
import {preview} from '@proxy/utils/harness';
import {cn} from '@proxy/ui/lib/utils';
import type {AttachmentInput} from '@/hooks/use-attachments';
import {useChatDraft} from '@/hooks/use-chat-draft';
import {FROM_COMMAND_BAR} from '@/lib/command-bar';
import {useLastLoaded, useLoaded} from '@/hooks/use-loaded';
import {personaChatPath, rememberLastThread} from '@/lib/last-thread';
import {rememberedPersonaList} from '@/lib/persona-list';
import {useListMotion} from '@/hooks/use-list-motion';
import {useOrgSlug} from '@/hooks/use-org';
import {usePoll} from '@/hooks/use-poll';
import {useReload} from '@/hooks/use-reload';
import {useSending} from '@/hooks/use-sending';
import {useUnread} from '@/hooks/use-unread';
import {rowDraftPreview} from '@/lib/chat-sidebar-preview';
import {formatAgo} from '@/lib/format';
import {describeApiError, describeFetchError} from '@/lib/loader-utils';
import {isDesktopApp} from '@/lib/desktop';
import {isShortcut} from '@/lib/platform';
import type {Shortcut} from '@/components/shortcut-hint';
import type {chatLoader} from '@/loaders';
import {OpenThread, THREAD_ROUTE, type ThreadContext, type ThreadLoad} from '@/pages/chat-thread';
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuTrigger,
} from '@proxy/ui/components/context-menu';

// A shortcut with N, as its button shows it: only in the desktop app, since a browser keeps Cmd+N
// and Cmd+Shift+N for its own windows, and the page never hears them.
function windowShortcut(shortcut: Shortcut): Shortcut | undefined {
	return isDesktopApp() ? shortcut : undefined;
}

// How often the chat is read again while a thread of it is in progress, so one that stops, or
// answers, shows within a moment; and how long after the last read the page coming back into view
// reads it again.
const IN_PROGRESS_POLL_MS = 4000;
const IN_PROGRESS_VISIBLE_GAP_MS = 2000;

type LastMessage = ChatPersona['lastMessage'];

// What a row shows under the name: the last thing said in the chat, the person's with "You:".
function subtitle(last: LastMessage): string {
	if (last === null) {
		return 'Nothing yet';
	}
	return last.kind === 'person' ? `You: ${last.text}` : last.text;
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
	onNew,
	onEdit,
	onDelete,
}: {
	personas: ChatPersona[];
	current: string;
	shown: Shown | null;
	recallDraft: (personaId: string) => string | null;
	onNew: () => void;
	onEdit: (persona: ChatPersona) => void;
	onDelete: (persona: ChatPersona) => void;
}) {
	const org = useOrgSlug();
	const unread = useUnread();
	const [hovered, setHovered] = useState<string | null>(null);
	const list = useListMotion<HTMLDivElement>();
	// How many of the persona's threads ended their turn with an answer the person hasn't opened
	// them to see, as the chat marks them, the open chat's too; and, with none, whether a thread at
	// work said something they haven't seen, but in the chat open, where it shows.
	const markedOf = (persona: ChatPersona) =>
		unread.answers
			?.find((answer) => answer.personaId === persona.id)
			?.unread.filter((thread) => thread.ended).length ?? 0;
	const isUnread = (persona: ChatPersona) =>
		persona.id !== current && unread.unreadIds.has(persona.id);
	const rows = personas
		.map((persona) => {
			const open = shown?.personaId === persona.id ? shown : null;
			return {
				persona,
				last: open ? latestOf([persona.lastMessage, open.last]) : persona.lastMessage,
				draft: rowDraftPreview(
					current,
					persona.id,
					open ? open.draft : (recallDraft(persona.id) ?? persona.draft),
				),
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
						const marked = markedOf(persona);
						const fresh = marked > 0 || isUnread(persona);
						const lit = persona.id === current;
						const row = (
							<Link
								// A chat opens on the thread it last had open, this one's on the one open.
								to={personaChatPath(org, persona.id)}
								aria-current={lit ? 'page' : undefined}
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
										{marked > 0 && (
											<span
												role="status"
												aria-label={`${marked} unread`}
												className="flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-primary px-1 text-[10px] leading-none font-medium text-primary-foreground"
											>
												{marked}
											</span>
										)}
										{marked === 0 && fresh && (
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
				<AddButton
					label="New agent"
					shortcut={windowShortcut({letter: 'n', shift: true})}
					variant="ghost"
					onClick={onNew}
					className="w-full"
				/>
			</div>
		</div>
	);
}

// The open thread's name in the title bar, with where it stands while in progress or waiting for
// the person (once done, its name alone): what stands for it while it loads, and a plain word for
// one the chat doesn't have, whose name will not come. The name is a field that looks like the
// words it holds (`ThreadTitle`), which renames the thread.
function ThreadName({
	thread,
	standing,
	missing,
	onRename,
}: {
	thread: ChatThread | null;
	standing: ThreadStanding | null;
	missing: boolean;
	onRename: (thread: ChatThread, title: string) => void;
}) {
	if (thread === null) {
		return missing ? <span className="text-sm font-medium">Thread</span> : <TitleWaiting />;
	}
	return (
		<>
			<ThreadTitle
				key={thread.id}
				title={thread.title || 'Thread'}
				onRename={(title) => onRename(thread, title)}
			/>
			{standing !== null && standing !== 'done' && <ThreadStatus standing={standing} />}
		</>
	);
}

// A thread's name as a field with no box, as a page's title in Notion: it reads as the name until
// clicked, then is edited where it stands, only as wide as what it holds. Enter, or leaving it,
// renames the thread where the name changed and isn't empty; Escape puts back what it was, and is
// taken by the field rather than closing the thread. While not edited it follows the name as it
// comes.
function ThreadTitle({title, onRename}: {title: string; onRename: (title: string) => void}) {
	const [value, setValue] = useState(title);
	const [editing, setEditing] = useState(false);
	if (!editing && value !== title) {
		setValue(title);
	}
	const kept = useRef(true);
	const finish = () => {
		setEditing(false);
		const next = value.trim();
		if (!kept.current || next === '' || next === title) {
			kept.current = true;
			setValue(title);
			return;
		}
		onRename(next);
	};
	return (
		<span className="inline-grid min-w-0 text-sm font-medium">
			{/* Sizes the field to the words in it, as a span would be. */}
			<span aria-hidden className="invisible col-start-1 row-start-1 truncate whitespace-pre pr-px">
				{value || ' '}
			</span>
			<input
				aria-label="Thread name"
				value={value}
				maxLength={200}
				spellCheck={false}
				onFocus={() => setEditing(true)}
				onChange={(event) => setValue(event.target.value)}
				onBlur={finish}
				onKeyDown={(event) => {
					if (event.nativeEvent.isComposing) {
						return;
					}
					if (event.key === 'Enter') {
						event.preventDefault();
						event.currentTarget.blur();
						return;
					}
					if (event.key === 'Escape') {
						event.preventDefault();
						kept.current = false;
						event.currentTarget.blur();
					}
				}}
				className="col-start-1 row-start-1 w-full min-w-0 truncate rounded-sm bg-transparent p-0 outline-none hover:bg-accent/60 focus:bg-transparent focus:text-clip"
			/>
		</span>
	);
}

// On a narrow window, where the list of tasks and the task open can't stand side by side, the way
// from the task back to the list.
function BackToList({to}: {to: string}) {
	return (
		<span className="flex lg:hidden">
			<IconButton label="Back to the tasks" to={to}>
				<ChevronLeftIcon className="size-4" />
			</IconButton>
		</span>
	);
}

// The open thread's cell of the title bar: its name (`ThreadName`), and, at the right, the check
// that says it is done where it waits for the person, or, once done, the button that archives it.
// A thread stays open until another is opened, or a new one started.
function ThreadHeader({
	thread,
	standing,
	missing,
	onDone,
	onArchive,
	onRename,
	listTo,
}: {
	thread: ChatThread | null;
	standing: ThreadStanding | null;
	// The address names a thread the chat doesn't have.
	missing: boolean;
	onDone: (thread: ChatThread) => void;
	onArchive: (thread: ChatThread) => void;
	onRename: (thread: ChatThread, title: string) => void;
	listTo: string;
}) {
	return (
		<>
			<BackToList to={listTo} />
			<ThreadName thread={thread} standing={standing} missing={missing} onRename={onRename} />
			<span className="flex-1" />
			{thread !== null && standing === 'waiting' && (
				<IconButton label={DONE_LABEL} onClick={() => onDone(thread)}>
					<CheckIcon className="size-4" />
				</IconButton>
			)}
			{thread !== null && (standing === 'done' || standing === 'watching') && (
				<IconButton label={ARCHIVE_LABEL} onClick={() => onArchive(thread)}>
					<ArchiveIcon className="size-4" />
				</IconButton>
			)}
		</>
	);
}

// What the person is asked as they say a thread with alerts that come to it is done, or archive
// it: the alerts would wake it again. Done, its alerts go with it or stay; archived, they go, as the
// server cancels them with it.
function AlertsPendingDialog({
	confirming,
	onClose,
	onDone,
	onArchive,
}: {
	confirming: {kind: 'done' | 'archive'; thread: ChatThread} | null;
	onClose: () => void;
	onDone: (thread: ChatThread, cancelAlerts: boolean) => void;
	onArchive: (thread: ChatThread) => void;
}) {
	// What it asked last, kept as it closes, so its words don't change as it fades.
	const [last, setLast] = useState(confirming);
	if (confirming !== null && confirming !== last) {
		setLast(confirming);
	}
	const asked = confirming ?? last;
	const count = asked?.thread.alerts ?? 0;
	const title = `This thread is still watching ${count} ${count === 1 ? 'thing' : 'things'}`;
	if (asked?.kind === 'archive') {
		return (
			<ConfirmDialog
				open={confirming !== null}
				title={title}
				description="Archiving it stops the watching."
				confirmLabel="Stop watching and archive"
				cancelLabel="Back"
				onClose={onClose}
				onConfirm={() => onArchive(asked.thread)}
			/>
		);
	}
	return (
		<ConfirmDialog
			open={confirming !== null}
			title={title}
			description="Its agent comes back to it when something turns up."
			confirmLabel="Stop watching and mark done"
			cancelLabel="Back"
			secondary={{
				label: 'Mark done, keep watching',
				onClick: () => {
					if (asked !== null) {
						onDone(asked.thread, false);
					}
				},
			}}
			onClose={onClose}
			onConfirm={() => {
				if (asked !== null) {
					onDone(asked.thread, true);
				}
			}}
		/>
	);
}

// The page: the organization's agents in the sidebar, beside the person's chat with the one in its
// address, a list of its threads as a second sidebar, and beside that, always, the thread the
// address names (pages/chat-thread.tsx), or, with none named, the box that starts a new one. The
// list of agents is the frame's, so moving to another chat shows it at once, lit in the list and
// named in the header, while it loads; the chat is started over as the agent in the address
// changes, so what one showed never lingers on another, and stays as it is as one thread of it
// opens after another.
export function ChatPage() {
	const org = useOrgSlug();
	const navigate = useNavigate();
	const reload = useReload();
	const {id: current = '', threadId} = useParams();
	// What the address's thread's route loads, which the thread open beside the chat is drawn from.
	const threadLoad = useRouteLoaderData<{later: ThreadLoad}>(THREAD_ROUTE)?.later;
	// The agents as last listed, with each chat as it loads; until the first has, as the list last
	// came anywhere (lib/persona-list.ts), so they are there as the page opens.
	const listed = useLastLoaded<typeof chatLoader>();
	const list = listed.answer ?? rememberedPersonaList(org);
	const personas = list?.personas ?? null;
	const persona = personas?.find((candidate) => candidate.id === current);
	const name = persona?.name;
	const [shownSaid, setShownSaid] = useState<ShownSaid | null>(null);
	const [shownDraft, setShownDraft] = useState<ShownDraft | null>(null);
	const [shownThreads, setShownThreads] = useState<ChatThread[]>([]);
	// The thread open beside the chat, as it shows it, while the address names it.
	const [shownAnyThread, setShownThread] = useState<ThreadView | null>(null);
	const shownThread = shownAnyThread?.thread.id === threadId ? shownAnyThread : null;
	// The chat whose new task's box floats over the page, by its id, until it is sent or put away.
	const [composingFor, setComposingFor] = useState<string | null>(null);
	// Whether the address names a thread the chat doesn't have, as the thread's place says.
	const [threadMissing, setThreadMissing] = useState(false);
	// The thread open in this chat, kept so opening the chat again goes back to it; none where it
	// is closed, or where the chat has no such thread.
	useEffect(() => {
		if (current !== '') {
			rememberLastThread(org, current, threadMissing ? null : (threadId ?? null));
		}
	}, [org, current, threadId, threadMissing]);
	// The agent dialog: making a new one, or changing the selected one; closed as null.
	const [editing, setEditing] = useState<'new' | ChatPersona | null>(null);
	const [deleting, setDeleting] = useState<ChatPersona | null>(null);
	const [error, setError] = useState<string | null>(null);
	// The threads the person said are done here, each by its id with when it last had a message
	// then, and whether its alerts stayed: until something more is said in it, it is done on the
	// page, or watching where alerts still come to it, whatever a read from before the server had it
	// says.
	const [markedDone, setMarkedDone] = useState<
		ReadonlyMap<string, {at: string; keptAlerts: boolean}>
	>(() => new Map());
	const standingOf = useCallback(
		(thread: ChatThread): ThreadStanding => {
			const marked = markedDone.get(thread.id);
			if (thread.standing !== 'waiting' || marked?.at !== thread.lastMessageAt) {
				return thread.standing;
			}
			return marked.keptAlerts && thread.alerts > 0 ? 'watching' : 'done';
		},
		[markedDone],
	);
	// Says a thread waiting for the person is done, on the page at once and then on the server,
	// cancelling the alerts that come to it where `cancelAlerts`, which the chat read again then no
	// longer counts; where the server can't be told, it waits again, and the chat's box says why.
	const markDone = useCallback(
		async (thread: ChatThread, cancelAlerts: boolean) => {
			setMarkedDone((before) =>
				new Map(before).set(thread.id, {at: thread.lastMessageAt, keptAlerts: !cancelAlerts}),
			);
			const marked = await markThreadDone(org, current, thread.id, cancelAlerts);
			if (marked.isOk()) {
				setError(null);
				if (cancelAlerts) {
					await reload();
				}
				return;
			}
			setMarkedDone((before) => {
				const after = new Map(before);
				after.delete(thread.id);
				return after;
			});
			setError(describeFetchError(marked.error));
		},
		[org, current, reload],
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
	// The threads the person renamed here, each by its id with its new name: so named on the page at
	// once, in the list and the title bar, until the chat read again has it from the server; where
	// the server can't be told, the old name is back, and the chat's box says why.
	const [renamed, setRenamed] = useState<ReadonlyMap<string, string>>(() => new Map());
	const titleOf = useCallback(
		(thread: ChatThread): string => renamed.get(thread.id) ?? thread.title,
		[renamed],
	);
	const rename = useCallback(
		async (thread: ChatThread, title: string) => {
			setRenamed((before) => new Map(before).set(thread.id, title));
			const done = await renameThread(org, current, thread.id, title);
			if (done.isOk()) {
				setError(null);
				await reload();
			}
			if (done.isErr()) {
				setError(describeFetchError(done.error));
			}
			setRenamed((before) => {
				if (before.get(thread.id) !== title) {
					return before;
				}
				const after = new Map(before);
				after.delete(thread.id);
				return after;
			});
		},
		[org, current, reload],
	);
	// A thread with alerts that come to it, as the person goes to say it is done or archive it: the
	// dialog that asks whether its alerts go too, since they would wake it again.
	const [confirming, setConfirming] = useState<{
		kind: 'done' | 'archive';
		thread: ChatThread;
	} | null>(null);
	const requestDone = useCallback(
		(thread: ChatThread) => {
			if (thread.alerts > 0) {
				setConfirming({kind: 'done', thread});
				return;
			}
			void markDone(thread, false);
		},
		[markDone],
	);
	const requestArchive = useCallback(
		(thread: ChatThread) => {
			if (thread.alerts > 0) {
				setConfirming({kind: 'archive', thread});
				return;
			}
			void archive(thread);
		},
		[archive],
	);
	// A chat picked in the command bar opens with a new task's box. Nothing opens on an ordinary
	// page load, so it does not steal focus or open a phone's keyboard just because the Chat page was
	// visited.
	const location = useLocation();
	const fromBar = location.state === FROM_COMMAND_BAR;
	const [arrival, setArrival] = useState<string | null>(null);
	if (arrival !== location.key) {
		setArrival(location.key);
		if (fromBar && threadId === undefined) {
			setComposingFor(current);
		}
	}
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
	const listedThread =
		threadId === undefined
			? null
			: shownThread?.thread.id === threadId
				? shownThread.thread
				: (shownThreads.find((thread) => thread.id === threadId) ?? null);
	const openThread =
		listedThread === null || titleOf(listedThread) === listedThread.title
			? listedThread
			: {...listedThread, title: titleOf(listedThread)};
	const chatTo = `/${org}/chat/${current}`;
	// The thread open beside the chat gives its place to a new one's box as it is archived.
	const openArchived = openThread !== null && isArchived(openThread);
	useEffect(() => {
		if (openArchived) {
			void navigate(chatTo);
		}
	}, [openArchived, navigate, chatTo]);
	const managing = editing !== null || deleting !== null;
	const composing = composingFor === current && current !== '';
	// A new task: its box, floating over the page, with the keyboard's focus.
	const newTask = useCallback(() => setComposingFor(current), [current]);
	const putAwayNewTask = useCallback(() => setComposingFor(null), []);
	// Cmd+N on a Mac, Ctrl+N elsewhere, starts one from anywhere on the page, and with Shift held
	// too, makes a new agent; but not under a dialog.
	useEffect(() => {
		if (managing || composing) {
			return;
		}
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.repeat || event.defaultPrevented) {
				return;
			}
			if (isShortcut(event, 'n', true)) {
				event.preventDefault();
				setEditing('new');
				return;
			}
			if (isShortcut(event, 'n') && current !== '') {
				event.preventDefault();
				newTask();
			}
		};
		window.addEventListener('keydown', onKeyDown);
		return () => window.removeEventListener('keydown', onKeyDown);
	}, [managing, composing, current, newTask]);
	const context: ThreadContext = {
		harnesses: list?.harnesses ?? [],
		// Under the new task's box, the thread's takes nothing dropped on the window.
		managing: managing || composing,
		onShown: setShownThread,
		onMissing: setThreadMissing,
	};
	const side: Side =
		threadId === undefined
			? {
					narrow: 'content',
					header: null,
					content: persona !== undefined && <NoTaskOpen persona={persona} onNewTask={newTask} />,
				}
			: {
					narrow: 'side',
					header: (
						<ThreadHeader
							thread={openThread}
							standing={openThread === null ? null : standingOf(openThread)}
							missing={threadMissing}
							onDone={requestDone}
							onArchive={requestArchive}
							onRename={(thread, title) => void rename(thread, title)}
							listTo={chatTo}
						/>
					),
					content: (
						// Each thread its own, and its own failure, while the chat stays as it is.
						<Suspense key={threadId} fallback={<Waiting column />}>
							<ContentBoundary key={threadId}>
								{threadLoad === undefined ? (
									<Waiting column />
								) : (
									<OpenThread later={threadLoad} {...context} />
								)}
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
				waiting={
					<div role="status" aria-label="Loading">
						<PanelWaiting />
					</div>
				}
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
					titleOf={titleOf}
					onDone={requestDone}
					isArchived={isArchived}
					onArchive={requestArchive}
					onNewTask={newTask}
					composing={composing}
					onPutAwayNewTask={putAwayNewTask}
					managing={managing}
					listError={error}
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
			<AlertsPendingDialog
				confirming={confirming}
				onClose={() => setConfirming(null)}
				onDone={(thread, cancelAlerts) => void markDone(thread, cancelAlerts)}
				onArchive={(thread) => void archive(thread)}
			/>
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
	// What a thread is named on the page, the person's renaming taken in.
	titleOf: (thread: ChatThread) => string;
	onDone: (thread: ChatThread) => void;
	// Whether the person archived a thread on the page, which the list leaves out, and archiving one.
	isArchived: (thread: ChatThread) => boolean;
	onArchive: (thread: ChatThread) => void;
	// Starts a new task: its box floats over the page while `composing`, until put away.
	onNewTask: () => void;
	composing: boolean;
	onPutAwayNewTask: () => void;
	// An agent is being made, changed or deleted in a dialog.
	managing: boolean;
	// What marking a thread done, archiving or renaming it, or deleting an agent failed with, said
	// over the list.
	listError: string | null;
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

// One thread in the chat's list, on one line, a row opening it beside the list: where it stands as
// an icon, its title, in bold where its turn ended with an answer the person hasn't opened it to
// see, and how long ago its last message came. Where it waits, a check
// that says it is done takes the time's place as the row is hovered or focused, and once it is
// done the button that archives it does; on a screen without a pointer that hovers, the button is
// always there. The one open is lit. The whole row is a link, under what it shows, so its button
// is a button, opening nothing; one just sent, which the server has yet to open, has no address to
// link to (`to` null), and opens nothing until it has. It is drawn again only as it changes.
const ThreadItem = memo(function ThreadItem({
	thread,
	to,
	open,
	unread,
	onDone,
	onArchive,
}: {
	thread: ChatThread;
	to: string | null;
	open: boolean;
	// Whether its turn ended with an answer the person hasn't opened it to see.
	unread: boolean;
	onDone: (thread: ChatThread) => void;
	onArchive: (thread: ChatThread) => void;
}) {
	const title = thread.title || (thread.opener?.kind === 'event' ? thread.opener.text : 'Thread');
	const waiting = thread.standing === 'waiting';
	// Done, or done with alerts that still come to it: either is archived from its row.
	const done = thread.standing === 'done' || thread.standing === 'watching';
	const acts = to !== null && (waiting || done);
	return (
		<div
			className={cn(
				'group/row relative flex h-8 items-center gap-2 rounded-lg px-2',
				open
					? 'bg-sidebar-accent text-sidebar-accent-foreground'
					: 'hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
			)}
		>
			{to !== null && (
				<Link
					to={to}
					aria-label={title}
					aria-current={open ? 'page' : undefined}
					className="absolute inset-0 rounded-lg outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
				/>
			)}
			<span className="pointer-events-none flex shrink-0 items-center">
				<ThreadStatusIcon standing={thread.standing} />
			</span>
			<span
				className={cn(
					'pointer-events-none min-w-0 flex-1 truncate text-sm',
					unread && 'font-semibold',
				)}
			>
				{title}
			</span>
			{/* Said to a screen reader; on screen, the title's weight says it. */}
			{unread && <span role="status" aria-label="Unread" className="sr-only" />}
			<span
				className={cn(
					'pointer-events-none shrink-0 text-xs text-muted-foreground tabular-nums',
					acts &&
						'group-focus-within/row:invisible group-hover/row:invisible pointer-coarse:invisible',
				)}
			>
				{formatAgo(thread.lastMessageAt)}
			</span>
			{acts && (
				<div className="invisible absolute top-1/2 right-1 flex -translate-y-1/2 group-focus-within/row:visible group-hover/row:visible pointer-coarse:visible">
					{waiting && <DoneButton onDone={() => onDone(thread)} />}
					{done && <ArchiveButton onArchive={() => onArchive(thread)} />}
				</div>
			)}
		</div>
	);
});

// The threads in the order the chat lists them, by when each was opened, the newest first, so that
// none moves when a message comes to it; those the page has fresher in their place.
function inOrder(threads: ChatThread[], fresher: ChatThread | null): ChatThread[] {
	const shown =
		fresher === null
			? threads
			: threads.map((thread) => (thread.id === fresher.id ? fresher : thread));
	return shown.toSorted((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

// The person's chat with one of the personas they see, as a second sidebar beside the thread open:
// its threads, the newest on top, read again while one of them is in progress, under them the
// chat's own alerts, those that open a thread of their own each time, as a line to the Alerts page
// showing them, and at its foot the button that starts a new task. While no thread is open, the
// box that starts one is in the thread's place (`newTaskSlot`): what is sent there shows at once
// on top of the list, before the server has it, and opens as the server has it. Each thread's agent
// acts as the person through the organization's built-in login, whose calls go through the same
// gate as any agent's, so its activity is in the log by the thread's task.
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
	titleOf,
	onDone,
	isArchived,
	onArchive,
	onNewTask,
	composing,
	onPutAwayNewTask,
	managing,
	listError,
}: Opened & {loaded: ChatThreads; harnesses: ChatHarness[]}) {
	const org = useOrgSlug();
	const navigate = useNavigate();
	const reload = useReload();
	const list = useListMotion<HTMLElement>();
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
				const title = titleOf(thread);
				if (standing === thread.standing && title === thread.title) {
					return [thread];
				}
				return [{...thread, standing, title}];
			}),
		[sending.entries, fresher, standingOf, titleOf, isArchived],
	);
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

	// The provider is told which chat the page shows, and, with a thread open, the thread's unread
	// answer, as the provider last asked, once the thread shows it: while the person looks at it,
	// the chat is neither counted nor notified of, and the thread is read up to that answer. The
	// chat's other threads are read as each is opened.
	const {setViewing, answers} = useUnread();
	const chatAnswers = answers?.find((candidate) => candidate.personaId === personaId) ?? null;
	const openUnread = chatAnswers?.unread.find((one) => one.threadId === threadId)?.answer ?? null;
	const answerId =
		openUnread !== null && fresher?.messages.some((message) => message.id === openUnread.id)
			? openUnread.id
			: null;
	useEffect(() => {
		setViewing({personaId, threadId, answerId});
		return () => {
			setViewing(null);
		};
	}, [setViewing, personaId, threadId, answerId]);

	// The threads whose turn ended with an answer the person hasn't opened them to see, as a
	// notification tells of them: each is marked until they do. The one open is read in a moment.
	const marked = new Set(
		(chatAnswers?.unread ?? [])
			.filter((one) => one.ended && one.threadId !== threadId)
			.map((one) => one.threadId),
	);

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
			messageCount: 1,
			lastMessageAt: at,
			createdAt: at,
			alerts: 0,
			openedByAlert: false,
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
		sent.current = posted.value.thread.id;
		await reload();
		return null;
	};
	// The thread just started opens once its box is done with the send.
	const sent = useRef<string | null>(null);
	const openSent = useCallback(() => {
		const id = sent.current;
		sent.current = null;
		onPutAwayNewTask();
		if (id !== null) {
			void navigate(`/${org}/chat/${personaId}/threads/${id}`);
		}
	}, [navigate, org, personaId, onPutAwayNewTask]);

	return (
		<>
			<nav
				ref={list}
				aria-label="Tasks"
				className="relative flex min-h-0 flex-1 flex-col overflow-y-auto p-2"
			>
				{listError !== null && <p className="px-2 pb-2 text-sm text-destructive">{listError}</p>}
				{threads.length === 0 && (
					<span className="px-2 py-1.5 text-sm text-muted-foreground">No tasks yet.</span>
				)}
				<ul className="flex flex-col gap-0.5">
					{threads.map((thread) => {
						const key = sending.keyOf(thread);
						// One just sent is the server's once the send has answered, before the chat read
						// again has it.
						const id = sending.idOf(thread);
						return (
							<li key={key} data-row={key}>
								<ThreadItem
									thread={thread}
									to={id === null ? null : `/${org}/chat/${personaId}/threads/${id}`}
									open={id !== null && id === threadId}
									unread={id !== null && marked.has(id)}
									onDone={onDone}
									onArchive={onArchive}
								/>
							</li>
						);
					})}
				</ul>
				{loaded.alerts > 0 && (
					<div className="px-2 pt-2">
						<AlertsLine
							count={loaded.alerts}
							to={`/${org}/alerts?chat=${encodeURIComponent(personaId)}`}
						/>
					</div>
				)}
			</nav>
			<div className="flex shrink-0 p-2">
				<AddButton
					label="New task"
					shortcut={windowShortcut({letter: 'n'})}
					variant="ghost"
					onClick={onNewTask}
					className="w-full"
				/>
			</div>
			{/* Put away, what was typed in it is kept as the chat's draft, for the next time. */}
			<Dialog
				open={composing}
				onOpenChange={(open) => {
					if (!open) {
						onPutAwayNewTask();
					}
				}}
			>
				<DialogContent
					showCloseButton={false}
					className="top-[14vh] translate-y-0 gap-0 bg-transparent p-0 ring-0 sm:max-w-2xl"
				>
					<DialogTitle className="sr-only">New task for {current.name}</DialogTitle>
					<ChatComposer
						persona={current}
						kept={loaded.draft ?? ''}
						keptFiles={loaded.draftAttachments}
						harnesses={harnesses}
						recallDraft={recallDraft}
						rememberDraft={rememberDraft}
						onShownDraft={onShownDraft}
						managing={managing}
						onSend={send}
						onSent={openSent}
					/>
				</DialogContent>
			</Dialog>
		</>
	);
});

// In the place of a thread, where none is open: the agent, what its tasks are, and the way to start
// one.
function NoTaskOpen({persona, onNewTask}: {persona: ChatPersona; onNewTask: () => void}) {
	return (
		<div className="page-column flex min-h-0 flex-1 flex-col items-center justify-center gap-2 overflow-y-auto py-12 text-center">
			<LiveHead look={persona.look} color={persona.color} size={64} />
			<p className="text-lg font-medium">What should {persona.name} do?</p>
			<p className="max-w-md text-sm text-muted-foreground">
				This conversation is yours alone. In each task, {persona.name} works on what you asked and
				answers you. It can use what is shared with everyone and what you connected yourself, as far
				as its access allows. Everything it does is in the activity log.
			</p>
			<div className="pt-2">
				<AddButton label="New task" shortcut={windowShortcut({letter: 'n'})} onClick={onNewTask} />
			</div>
		</div>
	);
}

// Nothing to do once the box has the focus it asked for.
function keepNothing() {}

// The box of a new task, floating over the page, with the keyboard's focus as it opens, which
// opens a thread with every message: what is typed in it is kept on the server as the chat's draft,
// and so are the files put in it, so it opens as it was left, on any device.
function ChatComposer({
	persona,
	kept,
	keptFiles,
	harnesses,
	recallDraft,
	rememberDraft,
	onShownDraft,
	managing,
	onSend,
	onSent,
}: Pick<Opened, 'recallDraft' | 'rememberDraft' | 'onShownDraft' | 'managing'> & {
	persona: ChatPersona;
	// The draft the server keeps, as the chat opened, and the files in its box.
	kept: string;
	keptFiles: ChatAttachment[];
	harnesses: ChatHarness[];
	onSent: () => void;
	onSend: (
		message: string,
		files: ChatAttachment[],
		settle: () => Promise<void>,
	) => Promise<string | null>;
}) {
	const org = useOrgSlug();
	const reload = useReload();
	const personaId = persona.id;
	// What runs the persona, which every thread opened from here starts with; switched here by
	// whoever may change the persona, and kept with it as it is otherwise.
	const model: ComposerModel = {
		chosen: {harness: persona.harness, chatModel: persona.chatModel},
		mayChange: persona.mayChange,
		onSwitch: async (choice) => {
			const changed = await updatePersona(org, personaId, {
				name: persona.name,
				look: persona.look,
				color: persona.color,
				...choice,
			});
			if (changed.isErr()) {
				return describeApiError(changed.error);
			}
			await reload();
			return null;
		},
	};
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
			model={model}
			label="Message"
			placeholder={`Message ${persona.name}`}
			input={input}
			keptFiles={keptFiles}
			openingText={opening.text}
			kept={draft}
			onTyped={onTyped}
			onWaiting={onWaiting}
			managing={managing}
			focusRequested
			onFocused={keepNothing}
			onSend={onSend}
			onSent={onSent}
			className="p-0 **:data-[slot=input-group]:shadow-lg **:data-[slot=input-group-control]:min-h-28"
		/>
	);
}
