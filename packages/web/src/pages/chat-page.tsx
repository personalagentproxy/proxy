import type {
	ChatEntry,
	ChatHarness,
	ChatMessage,
	ChatPersona,
	ChatAttachment,
	ChatTask,
	Persona,
	PinnedTask,
	TaskChat,
	ThreadLog,
} from '@proxy/contracts/harness';
import {
	CornerDownRightIcon,
	PaperclipIcon,
	PencilIcon,
	PinIcon,
	PinOffIcon,
	Trash2Icon,
} from 'lucide-react';
import {
	Fragment,
	type FormEvent,
	memo,
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from 'react';
import {Link, useNavigate, useParams} from 'react-router';
import {
	createPersona,
	deletePersona,
	getThread,
	pinTask,
	postMessage,
	removeAttachment,
	updatePersona,
	uploadAttachment,
} from '@/client/harness-client';
import {AddButton} from '@/components/add-button';
import {AppShell, PageTitle, PanelWaiting, TitleWaiting} from '@/components/app-shell';
import {ConfirmDialog} from '@/components/confirm-dialog';
import {LiveHead} from '@/components/head';
import {type ImageOf, Markdown} from '@/components/markdown';
import {type ModelChoice, ModelSwitcher} from '@/components/model-switcher';
import {PersonaDialog} from '@/components/persona-dialog';
import {PillButton} from '@proxy/ui/components/pill-button';
import {DropToAttach, SentChip, ShownFile} from '@/components/chat/attachments';
import {Bubble, BubbleContent} from '@/components/chat/bubble';
import {
	MessageEditor,
	type MessageEditorHandle,
	type Typed,
} from '@/components/chat/message-editor';
import {InputGroup, InputGroupAddon} from '@proxy/ui/components/input-group';
import {Message, MessageContent} from '@/components/chat/message';
import {
	MessageScroller,
	MessageScrollerButton,
	MessageScrollerContent,
	MessageScrollerItem,
	MessageScrollerViewport,
} from '@/components/chat/message-scroller';
import {TaskLine, WorkingLine} from '@/components/chat/task-line';
import {readFileLink} from '@proxy/utils/file-links';
import {ATTACHMENT_MARK, attachedParts, preview} from '@proxy/utils/harness';
import {cn} from '@proxy/ui/lib/utils';
import {type AttachmentInput, takenFiles, useAttachments} from '@/hooks/use-attachments';
import {useChatDraft} from '@/hooks/use-chat-draft';
import {useExperiments} from '@/hooks/use-experiment';
import {useLastLoaded, useLoaded} from '@/hooks/use-loaded';
import {useListMotion} from '@/hooks/use-list-motion';
import {useOrgSlug} from '@/hooks/use-org';
import {useReload} from '@/hooks/use-reload';
import {useSending} from '@/hooks/use-sending';
import {useReloadWhileHidden} from '@/hooks/use-reload-on-release';
import {useUnread} from '@/hooks/use-unread';
import {useWindowFileDrop} from '@/hooks/use-window-file-drop';
import {keepEntries, sameJson} from '@/lib/chat-log';
import {chatRuns, conversationSide} from '@/lib/chat-runs';
import {formatAgo} from '@/lib/format';
import {describeApiError, describeFetchError} from '@/lib/loader-utils';
import type {chatLoader, chatTaskLoader} from '@/loaders';
import {OpenTask} from '@/pages/task-chat';
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

// How an answer's pictures are shown: each that links to a file kept with the answer, as that
// file; any other as the link it is.
function shownFrom(attachments: ChatMessage['attachments']): ImageOf | null {
	if (attachments.length === 0) {
		return null;
	}
	return (src, alt, tile) => {
		const target = readFileLink(src, window.location.origin);
		const attachment = attachments.find(
			(candidate) =>
				candidate.connectionId === target?.connectionId && candidate.fileId === target.fileId,
		);
		return attachment === undefined ? null : (
			<ShownFile attachment={attachment} alt={alt} tile={tile} />
		);
	};
}

// One turn of the conversation: what the person said in a gray bubble on the right, as they typed
// it, with the files they attached where they put them, or what the persona answered on the left
// as plain Markdown, without a bubble, with the files it showed where it put them, in a red one
// where its turn failed.
function Turn({entry}: {entry: ChatMessage}) {
	if (entry.kind === 'person') {
		return (
			<Message align="end">
				<MessageContent>
					<Bubble align="end" variant="muted">
						<BubbleContent className="whitespace-pre-wrap">
							{attachedParts(entry.text, entry.attachments).map((part, index) =>
								'text' in part ? (
									<Fragment key={index}>{part.text}</Fragment>
								) : (
									<SentChip key={index} attachment={part.file} />
								),
							)}
						</BubbleContent>
					</Bubble>
				</MessageContent>
			</Message>
		);
	}
	return (
		<Message>
			<MessageContent>
				<Bubble variant={entry.isError ? 'destructive' : 'ghost'}>
					<BubbleContent>
						<Markdown text={entry.text} image={shownFrom(entry.attachments)} />
					</BubbleContent>
				</Bubble>
			</MessageContent>
		</Message>
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

// Whether something of the conversation is a turn of it, said by the person or the persona.
function isMessage(entry: ChatEntry): entry is ChatMessage {
	return entry.kind === 'person' || entry.kind === 'assistant';
}

// The last thing said in the open conversation, as the page has it, fresher than the list, cut
// to a line as the list has it.
function lastOf(log: ThreadLog): ChatPersona['lastMessage'] {
	const last = log.entries.findLast(isMessage);
	return last ? {kind: last.kind, text: preview(last.text), at: last.at} : null;
}

// When the persona was last active: the last thing said, or its making before anything was.
function lastActive(persona: ChatPersona, last: ChatPersona['lastMessage']): number {
	return Date.parse(last?.at ?? persona.createdAt);
}

// A conversation as the page shows it, fresher than the list: its log, and what is being typed.
type Shown = {personaId: string; log: ThreadLog; draft: string};

// Each as its own part of the conversation says it: the log as it is drawn, what is typed as it is
// typed, so typing draws the input and the list again, not the conversation.
type ShownLog = {personaId: string; log: ThreadLog};
type ShownDraft = {personaId: string; draft: string};

// The tasks a conversation names: those the persona started in it, and those it wrote to.
function tasksOf(log: ThreadLog): ChatTask[] {
	return log.entries.flatMap((entry) =>
		entry.kind === 'task' || entry.kind === 'sent' ? [entry.task] : [],
	);
}

// The personas the person sees, their own and General, in the second sidebar, each with its head, its name and the last
// thing said between it and the person, marked where the person hasn't seen it, or what they
// typed and haven't sent, the open one's as it is typed, the open one lit,
// each head watching the pointer while it is over that agent's row or its tasks'. The one last active is on
// top, the open one by its log, so what the person just said moves it up at once. It stays as it
// is from one conversation to the next: the one in the address is lit at once, while it loads.
// Under each, the tasks the person pinned in its conversation, the one with something said in it
// last first, then, under the open one, the task open in its place where it isn't pinned, lit in
// the agent's stead. A row that comes, goes or changes places moves there (`useListMotion`): a
// task opened or closed, pinned or unpinned, an agent made, deleted or moved up by what was said.
function PersonaList({
	personas,
	current,
	task,
	pinned,
	shown,
	recallDraft,
	onOpen,
	onEdit,
	onDelete,
	onPin,
}: {
	personas: ChatPersona[];
	current: string;
	// The task of the open agent's conversation that is open in its place, if one is.
	task: ChatTask | null;
	pinned: PinnedTask[];
	shown: Shown | null;
	recallDraft: (personaId: string) => string | null;
	onOpen: (personaId: string) => void;
	onEdit: (persona: ChatPersona) => void;
	onDelete: (persona: ChatPersona) => void;
	onPin: (personaId: string, taskId: string, pinned: boolean) => void;
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
				last: open ? lastOf(open.log) : persona.lastMessage,
				draft: draftLine(open ? open.draft : (recallDraft(persona.id) ?? persona.draft)),
			};
		})
		.toSorted((a, b) => lastActive(b.persona, b.last) - lastActive(a.persona, a.last));
	return (
		<div ref={list} className="relative flex h-full min-h-0 flex-col overflow-y-auto p-2">
			{personas.length === 0 && (
				<span className="px-2 py-1.5 text-sm text-muted-foreground">No agents yet.</span>
			)}
			<ul className="flex flex-col gap-0.5">
				{rows.map(({persona, last, draft}) => {
					const fresh = isUnread(persona);
					const open = persona.id === current;
					// The row is lit while its conversation is open, and the task's under it in its place.
					const lit = open && task === null;
					const pinnedHere = pinned.filter((candidate) => candidate.personaId === persona.id);
					const openTask =
						open && task !== null && !pinnedHere.some((candidate) => candidate.id === task.id)
							? [task]
							: [];
					const tasks = [...pinnedHere, ...openTask].map((candidate) => (
						<TaskRow
							key={candidate.id}
							task={candidate}
							to={`/${org}/chat/${persona.id}/tasks/${candidate.id}`}
							lit={open && candidate.id === task?.id}
							pinned={pinnedHere.some((pin) => pin.id === candidate.id)}
							onPin={(pin) => onPin(persona.id, candidate.id, pin)}
						/>
					));
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
						// The head watches the pointer while it is over the agent's row or its tasks'.
						<li
							key={persona.id}
							onPointerEnter={() => setHovered(persona.id)}
							onPointerLeave={() => setHovered(null)}
						>
							<div data-row={persona.id}>
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
							</div>
							{tasks.length > 0 && (
								<ul aria-label={`${persona.name}’s tasks`} className="flex flex-col">
									{tasks}
								</ul>
							)}
						</li>
					);
				})}
			</ul>
		</div>
	);
}

// A task in the list, under its agent: its title, opening its chat, lit while it is open, marked
// where it is pinned, and pinned or unpinned from its right-click menu. The gap above it is the
// row's own, so the room it takes in the list, and gives back, is all its own.
function TaskRow({
	task,
	to,
	lit,
	pinned,
	onPin,
}: {
	task: ChatTask;
	to: string;
	lit: boolean;
	pinned: boolean;
	onPin: (pinned: boolean) => void;
}) {
	return (
		<ContextMenu>
			<ContextMenuTrigger render={<li data-row={task.id} />}>
				<div className="pt-0.5">
					<Link
						to={to}
						aria-current={lit ? 'page' : undefined}
						className={cn(
							'flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-muted-foreground hover:bg-sidebar-accent',
							lit && 'bg-sidebar-accent',
						)}
					>
						<CornerDownRightIcon className="size-4 shrink-0" aria-hidden />
						<span className="min-w-0 flex-1 truncate font-medium text-sidebar-foreground">
							{task.title}
						</span>
						{pinned && <PinIcon className="size-3.5 shrink-0" aria-label="Pinned" />}
					</Link>
				</div>
			</ContextMenuTrigger>
			<ContextMenuContent>
				<ContextMenuItem onClick={() => onPin(!pinned)}>
					{pinned ? <PinOffIcon /> : <PinIcon />}
					{pinned ? 'Unpin' : 'Pin'}
				</ContextMenuItem>
			</ContextMenuContent>
		</ContextMenu>
	);
}

// The page: the organization's agents beside the conversation with the one in its address. The
// list is the frame's, so moving to another conversation shows it at once, lit in the list and
// named in the header, while it loads; the conversation is started over as the address changes,
// so what one showed never lingers on another. A task of the conversation opens in its place, as
// the address names it, under the agent in the list.
export function ChatPage() {
	const org = useOrgSlug();
	const navigate = useNavigate();
	const reload = useReload();
	const {id: current = '', taskId} = useParams();
	// The agents as last listed, with each conversation, or task of one, as it loads.
	const listed = useLastLoaded<typeof chatLoader | typeof chatTaskLoader>();
	const personas = listed.answer?.personas ?? null;
	const name = personas?.find((persona) => persona.id === current)?.name;
	const [shownLog, setShownLog] = useState<ShownLog | null>(null);
	const [shownDraft, setShownDraft] = useState<ShownDraft | null>(null);
	const shown: Shown | null =
		shownLog !== null && shownDraft?.personaId === shownLog.personaId
			? {...shownLog, draft: shownDraft.draft}
			: null;
	// The agent dialog: making a new one, or changing the selected one; closed as null.
	const [editing, setEditing] = useState<'new' | ChatPersona | null>(null);
	const [deleting, setDeleting] = useState<ChatPersona | null>(null);
	const [error, setError] = useState<string | null>(null);
	// A conversation picked in the list focuses its input once that conversation has loaded.
	// Nothing is requested on an ordinary page load, so it does not steal focus or open a phone's
	// keyboard just because the Chat page was visited.
	const [focusRequestedFor, setFocusRequestedFor] = useState<string | null>(null);
	const focused = useCallback(() => setFocusRequestedFor(null), [setFocusRequestedFor]);
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

	// Deletes a persona with the conversations with it: the person's, and for one every member
	// sees, everyone's. If it was open, opens whichever is
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

	// The task the address names, once it has loaded.
	const answer = listed.answer;
	const task =
		taskId !== undefined && answer !== null && 'task' in answer && answer.task.task.id === taskId
			? answer.task
			: null;
	const pinned = answer?.pinnedTasks ?? [];
	// The task as the header and the list name it, in the agent's place: as loaded, or, while it
	// loads, as the page has it already, pinned or named in the conversation it was opened from. So
	// its title and its row under the agent are there as it is opened, not once it has loaded.
	const named: ChatTask | null =
		task?.task ??
		[...pinned, ...(shown?.personaId === current ? tasksOf(shown.log) : [])].find(
			(known) => known.id === taskId,
		) ??
		null;
	// The conversation as it was last shown is fresher than the list while the list is the one
	// loaded with a conversation; one loaded with a task since is fresher than it.
	const fresher = answer !== null && 'log' in answer ? shown : null;

	// Pins a task under its agent, or unpins it, and reads the list again with it so.
	const pinOne = async (personaId: string, pinnedTaskId: string, pin: boolean) => {
		const done = await pinTask(org, personaId, pinnedTaskId, pin);
		if (done.isErr()) {
			setError(describeFetchError(done.error));
			return;
		}
		setError(null);
		await reload();
	};

	const title = () => {
		if (taskId !== undefined) {
			return named === null ? <TitleWaiting /> : <PageTitle>{named.title}</PageTitle>;
		}
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
				task={named}
				pinned={pinned}
				onPin={(personaId, pinnedTaskId, pin) => void pinOne(personaId, pinnedTaskId, pin)}
				shown={fresher}
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
				actions={
					taskId === undefined ? (
						<AddButton label="New agent" onClick={() => setEditing('new')} />
					) : (
						<TaskActions task={task} />
					)
				}
				panel={panel()}
				panelLabel="Agents"
				scroll="inside"
			>
				{taskId === undefined ? (
					<OpenConversation
						recallDraft={recallDraft}
						rememberDraft={rememberDraft}
						onShownLog={setShownLog}
						onShownDraft={setShownDraft}
						managing={editing !== null || deleting !== null}
						listError={error}
						focusRequested={focusRequestedFor === current}
						onFocused={focused}
					/>
				) : (
					<OpenTask />
				)}
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

// What the header offers in a task's place: its requests in the activity log, once it made one.
function TaskActions({task}: {task: TaskChat | null}) {
	const org = useOrgSlug();
	const activityTaskId = task?.activityTaskId ?? null;
	if (activityTaskId === null) {
		return null;
	}
	return (
		<PillButton
			variant="ghost"
			nativeButton={false}
			render={<Link to={`/${org}/activity/tasks/${encodeURIComponent(activityTaskId)}`} />}
		>
			View activity
		</PillButton>
	);
}

// What the page gives the conversation open in it.
type Opened = {
	recallDraft: (personaId: string) => string | null;
	rememberDraft: (personaId: string, text: string) => void;
	// The list beside the conversation shows it as the page does: its log, and what is typed in it.
	onShownLog: (shown: ShownLog) => void;
	onShownDraft: (shown: ShownDraft) => void;
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

// What the person said in something of the conversation; null for what isn't theirs.
function personText(entry: ChatEntry): string | null {
	return entry.kind === 'person' ? entry.text : null;
}

// One thing of the conversation: a turn, or a line about one of its tasks. It is drawn again only
// as it changes, not as the conversation is read again or something else comes, since drawing an
// answer parses its Markdown; one that came while the conversation was open rises into place.
const Entry = memo(function Entry({
	entry,
	fresh,
	org,
	personaId,
}: {
	entry: ChatEntry;
	fresh: boolean;
	org: string;
	personaId: string;
}) {
	if (entry.kind === 'task' || entry.kind === 'sent') {
		return (
			<div data-enter={fresh ? 'rise' : undefined}>
				<TaskLine
					verb={entry.kind === 'task' ? 'Created task' : 'Sent to'}
					task={entry.task}
					to={`/${org}/chat/${personaId}/tasks/${entry.task.id}`}
				/>
			</div>
		);
	}
	return (
		<div data-enter={fresh ? 'rise' : undefined}>
			<Turn entry={entry} />
		</div>
	);
});

// The person's conversation with one of the personas they see: its log, read again as the
// persona works, and an input. The persona hands each piece of work to a sub-agent it keeps
// talking with, which acts as the person through the organization's built-in login, whose calls
// go through the same gate as any agent's, so its activity is in the log by the sub-agent's task.
// Each sub-agent is a task to the person, a line where it was started and one where the persona
// sent it more, each opening its chat. What the person sends shows at once, the persona at work
// under it, before the server has it.
const Conversation = memo(function Conversation({
	loaded,
	harnesses,
	recallDraft,
	rememberDraft,
	onShownLog,
	onShownDraft,
	managing,
	listError,
	focusRequested,
	onFocused,
}: Opened & {loaded: ThreadLog; harnesses: ChatHarness[]}) {
	const org = useOrgSlug();
	const reload = useReload();
	const [log, setLog] = useState<ThreadLog>(loaded);
	const personaId = loaded.persona.id;
	const current = loaded.persona;
	const sending = useSending(log.entries, personText);
	const busy = log.busy || sending.waiting;
	// What the conversation had as it opened: what comes after it rises into place.
	const [opened] = useState(() => new Set(loaded.entries.map((entry) => entry.id)));

	// The log as it is shown, what was just sent in it, said as it is drawn, so the list shows the
	// conversation as it is shown, and from the answer it came with, in the same frame.
	const shownLog = useMemo(
		() => ({...log, entries: sending.entries, busy}),
		[log, sending.entries, busy],
	);
	useLayoutEffect(() => {
		onShownLog({personaId, log: shownLog});
	}, [onShownLog, personaId, shownLog]);

	// Which read of the log was asked for last: one asked for before it that answers after it is
	// dropped, so a poll begun before a send can't put back the log as it was without the message.
	// A read that brings nothing new changes nothing, and what didn't change is kept as it was, so
	// the conversation isn't drawn again for it.
	const latestRead = useRef(0);
	const readLog = useCallback(async () => {
		latestRead.current += 1;
		const read = latestRead.current;
		const result = await getThread(org, personaId);
		if (read !== latestRead.current || result.isErr()) {
			return;
		}
		const after = result.value;
		setLog((before) =>
			sameJson(before, after)
				? before
				: {...after, entries: keepEntries(before.entries, after.entries)},
		);
	}, [org, personaId]);

	// The log as it is now, while the page is open.
	useEffect(() => {
		const timer = setInterval(() => void readLog(), busy ? BUSY_POLL_MS : IDLE_POLL_MS);
		return () => {
			clearInterval(timer);
		};
	}, [readLog, busy]);

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

	// Sends what the person wrote, with the files placed among it, shown at once and taken away
	// again where the send fails, once `settle` has: what it failed with, or null.
	const send = async (
		message: string,
		files: ChatAttachment[],
		settle: () => Promise<void>,
	): Promise<string | null> => {
		const key = `sending-${crypto.randomUUID()}`;
		sending.start({
			id: key,
			kind: 'person',
			text: message,
			isError: false,
			at: new Date().toISOString(),
			attachments: files,
		});
		await settle();
		const posted = await postMessage(org, personaId, message, files);
		if (posted.isErr()) {
			sending.failed(key);
			return describeApiError(posted.error);
		}
		sending.posted(key, posted.value.entry.id);
		await readLog();
		return null;
	};

	// Turns in a row from the same side sit closer together than the sides do, under the time
	// their stretch of the conversation began.
	const runs = chatRuns(sending.entries, new Date(), conversationSide);

	return (
		<>
			<MessageScroller className="min-h-0 flex-1">
				<MessageScrollerViewport aria-label="Conversation">
					<MessageScrollerContent className="page-column mx-auto w-full max-w-4xl pt-6 pb-4">
						{runs.length === 0 && (
							<div className="flex flex-1 flex-col items-center justify-center gap-2 py-12 text-center">
								<LiveHead look={current.look} color={current.color} size={64} />
								<p className="text-lg font-medium">What should {current.name} do?</p>
								<p className="max-w-md text-sm text-muted-foreground">
									This conversation is yours alone. {current.name} can use what is shared with
									everyone and what you connected yourself, as far as its access allows. Everything
									it does is in the activity log.
								</p>
							</div>
						)}
						{runs.map((run) => {
							const first = run.entries[0];
							if (!first) {
								return null;
							}
							const key = sending.keyOf(first);
							return (
								<MessageScrollerItem
									key={key}
									scrollAnchor={sending.sentHere(first)}
									className="flex flex-col gap-4"
								>
									{run.heading !== null && (
										<h2 className="text-center text-xs font-medium text-muted-foreground">
											{run.heading}
										</h2>
									)}
									<div className="flex flex-col gap-2">
										{run.entries.map((entry) => {
											const entryKey = sending.keyOf(entry);
											return (
												<Entry
													key={entryKey}
													entry={entry}
													fresh={!opened.has(entryKey)}
													org={org}
													personaId={personaId}
												/>
											);
										})}
									</div>
								</MessageScrollerItem>
							);
						})}
						{busy && (
							<MessageScrollerItem>
								<div data-enter="fade">
									<WorkingLine />
								</div>
							</MessageScrollerItem>
						)}
					</MessageScrollerContent>
				</MessageScrollerViewport>
				<MessageScrollerButton />
			</MessageScroller>
			<Composer
				persona={current}
				kept={loaded.draft ?? ''}
				keptFiles={loaded.draftAttachments}
				harnesses={harnesses}
				recallDraft={recallDraft}
				rememberDraft={rememberDraft}
				onShownDraft={onShownDraft}
				managing={managing}
				listError={listError}
				focusRequested={focusRequested}
				onFocused={onFocused}
				onSend={send}
			/>
		</>
	);
});

// The input under the conversation, with what runs the persona. What is typed is its own, so
// typing draws the input, and the list's line for the draft, not the conversation over it. A
// message sent leaves the input at once, its files with it, and comes back to it where the send
// fails.
function Composer({
	persona,
	kept,
	keptFiles,
	harnesses,
	recallDraft,
	rememberDraft,
	onShownDraft,
	managing,
	listError,
	focusRequested,
	onFocused,
	onSend,
}: Omit<Opened, 'onShownLog'> & {
	persona: ChatPersona;
	// The draft the server keeps, as the conversation opened, and the files in its input.
	kept: string;
	keptFiles: ChatAttachment[];
	harnesses: ChatHarness[];
	// Sends a message, with the files placed among it, once `settle` has: what it failed with, or
	// null.
	onSend: (
		message: string,
		files: ChatAttachment[],
		settle: () => Promise<void>,
	) => Promise<string | null>;
}) {
	const org = useOrgSlug();
	const reload = useReload();
	const personaId = persona.id;
	// What goes with the next message: the files the person put in the input, where the
	// organization has Files, those put there before among them, as the server keeps them. Sent
	// once none is still on its way up, with words, files, or both.
	const attaches = useExperiments().includes('files');
	const input = useMemo(
		(): AttachmentInput => ({
			upload: (file) => uploadAttachment(org, personaId, file),
			remove: (attachment) => void removeAttachment(org, personaId, attachment),
		}),
		[org, personaId],
	);
	const attachments = useAttachments(input, keptFiles);
	// The files in the input now, as a send that waited on the server finds them.
	const pendingNow = useRef(attachments.pending);
	useLayoutEffect(() => {
		pendingNow.current = attachments.pending;
	});
	// What was typed and not sent, as the conversation opened: as this page left it, or as the
	// server keeps it. Read once: the log read again later says nothing of what is being typed.
	const [opening] = useState(() => ({kept, text: recallDraft(personaId) ?? kept}));
	// What the box opens holding: what was typed as the conversation opened, or, made again where
	// a send failed (`made` times), what the send gave back.
	const [box, setBox] = useState(() => ({made: 0, text: opening.text, files: attachments.pending}));
	// What is typed, with a mark where each file sits among the words, and those files in the
	// order of their marks (message-editor.tsx).
	const [text, setText] = useState(opening.text);
	const [placed, setPlaced] = useState(keptFiles);
	// What is in the box now, as a send that waited on the server finds it.
	const typedNow = useRef<Typed>({text: opening.text, files: keptFiles});
	const draft = useChatDraft(org, personaId, opening.kept);
	const [sending, setSending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const form = useRef<HTMLFormElement>(null);
	const editor = useRef<MessageEditorHandle>(null);
	// What runs the persona, as the switcher shows it: the persona's, or what was just picked.
	const [runsOn, setRunsOn] = useState<ModelChoice>({
		harness: persona.harness,
		chatModel: persona.chatModel,
	});
	// A conversation is open all day: a new release is loaded while it is out of view, as long as
	// what is typed is saved as the draft and no dialog is open, since the log and the draft come
	// back from the server.
	useReloadWhileHidden(text === draft.saved && !sending && !managing && !attachments.uploading);

	// What the list says is waiting here: what is typed, or, with nothing typed, the files' names.
	// Said as it is drawn, so the list shows the draft as it is typed.
	const words = text.replaceAll(ATTACHMENT_MARK, '').trim();
	const waiting = words === '' ? attachments.pending.map((one) => one.name).join(', ') : text;
	useLayoutEffect(() => {
		onShownDraft({personaId, draft: waiting});
	}, [onShownDraft, personaId, waiting]);

	useEffect(() => {
		if (!focusRequested || editor.current === null) {
			return;
		}
		editor.current.focus();
		onFocused();
	}, [focusRequested, onFocused]);

	// The box made again, where a send failed, keeps the caret.
	useEffect(() => {
		if (box.made > 0) {
			editor.current?.focus();
		}
	}, [box.made]);

	// What this page had typed here that the server doesn't have yet, as it was left for another
	// conversation a moment before its save landed, is saved again.
	const {typed} = draft;
	useEffect(() => {
		if (opening.text !== opening.kept) {
			typed(opening.text);
		}
	}, [typed, opening]);

	// What the box shows, as the page remembers it; `type` saves it as the draft too.
	const show = (typed: Typed) => {
		setText(typed.text);
		setPlaced(typed.files);
		typedNow.current = typed;
		rememberDraft(personaId, typed.text);
	};
	const type = (typed: Typed) => {
		show(typed);
		draft.typed(typed.text, typed.files);
	};

	// Switches what runs the persona, the harness and the model, from the input's switcher: shown
	// at once, kept with the persona as it is otherwise, and put back where the server refused it.
	const switchModel = async (choice: ModelChoice) => {
		const before = runsOn;
		setRunsOn(choice);
		setError(null);
		const changed = await updatePersona(org, personaId, {
			name: persona.name,
			look: persona.look,
			color: persona.color,
			...choice,
		});
		if (changed.isErr()) {
			setRunsOn(before);
			setError(describeFetchError(changed.error));
			return;
		}
		await reload();
	};

	const picker = useRef<HTMLInputElement>(null);
	// A file that could not be uploaded says why under the conversation, by its name.
	const failedFile = attachments.pending.find((one) => one.error !== null);
	const failedUpload = failedFile ? `${failedFile.name}: ${failedFile.error ?? ''}` : null;
	const sendable = !attachments.uploading && (words !== '' || placed.length > 0);
	// Files dropped anywhere on the window are attached, unless a dialog is open over the page.
	const dropping = useWindowFileDrop(attaches && !managing, attachments.add);

	// The message leaves the box at once, its files with it. Where the send fails, it comes back,
	// before anything typed since; where it doesn't, what was typed since is saved as the draft,
	// which the send forgot.
	const submit = async (event: FormEvent) => {
		event.preventDefault();
		const message = text.trim();
		if (!sendable || sending) {
			return;
		}
		const files = placed;
		const taken = takenFiles(attachments.pending, files);
		setSending(true);
		setError(null);
		editor.current?.clear();
		attachments.sent();
		show({text: '', files: []});
		const failed = await onSend(message, files, draft.settle);
		setSending(false);
		if (failed !== null) {
			setError(failed);
			const since = typedNow.current;
			const back: Typed = {
				text: since.text === '' ? text : `${text}\n${since.text}`,
				files: [...files, ...since.files],
			};
			attachments.restore(taken);
			setBox((before) => ({
				made: before.made + 1,
				text: back.text,
				files: [...taken, ...takenFiles(pendingNow.current, since.files)],
			}));
			type(back);
			return;
		}
		draft.sent();
		if (typedNow.current.text !== '') {
			draft.typed(typedNow.current.text, typedNow.current.files);
		}
	};

	const shownError = error ?? attachments.refused ?? failedUpload ?? listError;

	return (
		<form
			ref={form}
			onSubmit={(event) => void submit(event)}
			className="page-column mx-auto flex w-full max-w-4xl shrink-0 flex-col gap-2 pt-2 pb-4"
		>
			{dropping && <DropToAttach name={persona.name} />}
			{shownError && <p className="text-sm text-destructive">{shownError}</p>}
			<input
				ref={picker}
				type="file"
				multiple
				className="hidden"
				aria-label="Files to attach"
				onChange={(event) => {
					const picked = [...(event.target.files ?? [])];
					event.target.value = '';
					attachments.add(picked);
				}}
			/>
			{/* No focus ring: the caret in the only input on the page says where typing goes. */}
			<InputGroup className="rounded-xl bg-background shadow-xs has-[[data-slot=input-group-control]:focus-visible]:border-input has-[[data-slot=input-group-control]:focus-visible]:ring-0">
				<MessageEditor
					key={box.made}
					ref={editor}
					opening={box}
					files={attachments.pending}
					label="Message"
					placeholder={`Message ${persona.name}`}
					onChange={type}
					onRemove={attachments.remove}
					onFiles={attaches ? attachments.add : undefined}
					onSubmit={() => form.current?.requestSubmit()}
				/>
				{/* The model's name starts where the message's hint does: 5px, the switcher's 1px border
				    and its 6px padding make the textarea's 12px. It sits on the send button's bottom. */}
				<InputGroupAddon align="block-end" className="items-end pl-[5px]">
					<ModelSwitcher
						harnesses={harnesses}
						chosen={runsOn}
						mayChange={persona.mayChange}
						onPick={(choice) => void switchModel(choice)}
					/>
					{attaches && (
						<PillButton
							type="button"
							variant="ghost"
							icon
							className="ml-auto"
							onClick={() => picker.current?.click()}
							aria-label="Attach files"
						>
							<PaperclipIcon />
						</PillButton>
					)}
					{/* The command bar's main button without its label: Enter's mark, as Enter sends. */}
					<PillButton
						type="submit"
						enter
						className={cn(!attaches && 'ml-auto')}
						disabled={sending || !sendable}
						aria-label="Send"
					/>
				</InputGroupAddon>
			</InputGroup>
		</form>
	);
}
