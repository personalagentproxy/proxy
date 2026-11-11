import type {
	ChatEntry,
	ChatHarness,
	ChatMessage,
	ChatPersona,
	ChatTask,
	Persona,
	PinnedTask,
	TaskChat,
	ThreadLog,
} from '@proxy/contracts/harness';
import {CornerDownRightIcon, PencilIcon, PinIcon, PinOffIcon, Trash2Icon} from 'lucide-react';
import {
	type FormEvent,
	type KeyboardEvent,
	useCallback,
	useEffect,
	useLayoutEffect,
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
	updatePersona,
} from '@/client/harness-client';
import {AddButton} from '@/components/add-button';
import {Button} from '@proxy/ui/components/button';
import {AppShell, PageTitle, PanelWaiting, TitleWaiting} from '@/components/app-shell';
import {ConfirmDialog} from '@/components/confirm-dialog';
import {LiveHead} from '@/components/head';
import {Markdown} from '@/components/markdown';
import {type ModelChoice, ModelSwitcher} from '@/components/model-switcher';
import {PersonaDialog} from '@/components/persona-dialog';
import {PillButton} from '@/components/pill-button';
import {Bubble, BubbleContent} from '@/components/chat/bubble';
import {InputGroup, InputGroupAddon, InputGroupTextarea} from '@proxy/ui/components/input-group';
import {Message, MessageContent} from '@/components/chat/message';
import {
	MessageScroller,
	MessageScrollerButton,
	MessageScrollerContent,
	MessageScrollerItem,
	MessageScrollerProvider,
	MessageScrollerViewport,
} from '@/components/chat/message-scroller';
import {TaskLine, WorkingLine} from '@/components/chat/task-line';
import {preview} from '@proxy/utils/harness';
import {cn} from '@proxy/ui/lib/utils';
import {useChatDraft} from '@/hooks/use-chat-draft';
import {useLastLoaded, useLoaded} from '@/hooks/use-loaded';
import {useOrgSlug} from '@/hooks/use-org';
import {useReload} from '@/hooks/use-reload';
import {useReloadWhileHidden} from '@/hooks/use-reload-on-release';
import {useUnread} from '@/hooks/use-unread';
import {chatRuns, conversationSide} from '@/lib/chat-runs';
import {formatAgo} from '@/lib/format';
import {describeFetchError} from '@/lib/loader-utils';
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

// One turn of the conversation: what the person said in a dark bubble on the right (a light one
// in dark mode), as they typed it, or what the persona answered in a gray one on the left, as
// Markdown, in a red one where its turn failed.
function Turn({entry}: {entry: ChatMessage}) {
	if (entry.kind === 'person') {
		return (
			<Message align="end">
				<MessageContent>
					<Bubble align="end" variant="inverted">
						<BubbleContent className="whitespace-pre-wrap">{entry.text}</BubbleContent>
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

// The personas the person sees, their own and General, in the second sidebar, each with its head, its name and the last
// thing said between it and the person, marked where the person hasn't seen it, or what they
// typed and haven't sent, the open one's as it is typed, the open one lit,
// each head watching the pointer while it is over that agent's row or its tasks'. The one last active is on
// top, the open one by its log, so what the person just said moves it up at once. It stays as it
// is from one conversation to the next: the one in the address is lit at once, while it loads.
// Under each, the tasks the person pinned in its conversation, the one with something said in it
// last first, then, under the open one, the task open in its place where it isn't pinned, lit in
// the agent's stead.
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
							{tasks.length > 0 && (
								<ul aria-label={`${persona.name}’s tasks`} className="flex flex-col gap-0.5 pt-0.5">
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
// where it is pinned, and pinned or unpinned from its right-click menu.
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
			<ContextMenuTrigger render={<li />}>
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

	// The task the address names, once it has loaded: its title heads the page in the agent's place.
	const answer = listed.answer;
	const task =
		taskId !== undefined && answer !== null && 'task' in answer && answer.task.task.id === taskId
			? answer.task
			: null;

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
			return task === null ? <TitleWaiting /> : <PageTitle>{task.task.title}</PageTitle>;
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
				task={task?.task ?? null}
				pinned={listed.answer?.pinnedTasks ?? []}
				onPin={(personaId, pinnedTaskId, pin) => void pinOne(personaId, pinnedTaskId, pin)}
				shown={taskId === undefined ? shown : null}
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
						onShown={setShown}
						managing={editing !== null || deleting !== null}
						listError={error}
						focusRequested={focusRequestedFor === current}
						onFocused={() => setFocusRequestedFor(null)}
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
		<Button
			variant="outline"
			size="sm"
			nativeButton={false}
			render={<Link to={`/${org}/activity/tasks/${encodeURIComponent(activityTaskId)}`} />}
		>
			View activity
		</Button>
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

// The person's conversation with one of the personas they see: its log, read again as the
// persona works, and an input. The persona hands each piece of work to a sub-agent it keeps
// talking with, which acts as the person through the organization's built-in login, whose calls
// go through the same gate as any agent's, so its activity is in the log by the sub-agent's task.
// Each sub-agent is a task to the person, a line where it was started and one where the persona
// sent it more, each opening its chat.
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
	// What runs the persona, as the switcher shows it: the persona's, or what was just picked.
	const [runsOn, setRunsOn] = useState<ModelChoice>({
		harness: current.harness,
		chatModel: current.chatModel,
	});
	// A conversation is open all day: a new release is loaded while it is out of view, as long as
	// what is typed is saved as the draft and no dialog is open, since the log and the draft come
	// back from the server.
	useReloadWhileHidden(text === draft.saved && !sending && !managing);

	// Said as it is drawn, so the list shows the conversation as it is shown, and from the answer
	// it came with, in the same frame.
	useLayoutEffect(() => {
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

	const shownEntry = (entry: ChatEntry) => {
		if (entry.kind === 'task' || entry.kind === 'sent') {
			return (
				<TaskLine
					key={entry.id}
					verb={entry.kind === 'task' ? 'Created task' : 'Sent to'}
					task={entry.task}
					to={`/${org}/chat/${personaId}/tasks/${entry.task.id}`}
				/>
			);
		}
		return <Turn key={entry.id} entry={entry} />;
	};

	// Turns in a row from the same side sit closer together than the sides do, under the time
	// their stretch of the conversation began.
	const runs = chatRuns(log.entries, new Date(), conversationSide);

	return (
		<>
			<MessageScrollerProvider autoScroll defaultScrollPosition="end">
				<MessageScroller className="min-h-0 flex-1">
					<MessageScrollerViewport aria-label="Conversation">
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
									<div className="flex flex-col gap-2">{run.entries.map(shownEntry)}</div>
								</MessageScrollerItem>
							))}
							{log.busy && (
								<MessageScrollerItem messageId="status">
									<WorkingLine />
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
						{/* The command bar's main button without its label: Enter's mark, as Enter sends. */}
						<PillButton
							type="submit"
							enter
							className="ml-auto"
							disabled={sending || text.trim() === ''}
							aria-label="Send"
						/>
					</InputGroupAddon>
				</InputGroup>
			</form>
		</>
	);
}
