import type {ChatEntry, ChatPersona, Persona, ThreadLog} from '@proxy/contracts/harness';
import {ArrowUpIcon, MoonIcon, PencilIcon, PinIcon, PinOffIcon, Trash2Icon} from 'lucide-react';
import {type FormEvent, type KeyboardEvent, useCallback, useEffect, useRef, useState} from 'react';
import {Link, useLoaderData, useNavigate, useRevalidator} from 'react-router';
import {
	createPersona,
	deletePersona,
	getThread,
	postMessage,
	setPersonaPinned,
	updatePersona,
} from '@/client/harness-client';
import {AddButton} from '@/components/add-button';
import {AppShell, PageTitle} from '@/components/app-shell';
import {ConfirmDialog} from '@/components/confirm-dialog';
import {LiveHead} from '@/components/head';
import {Markdown} from '@/components/markdown';
import {PersonaDialog} from '@/components/persona-dialog';
import {Bubble, BubbleContent} from '@/components/chat/bubble';
import {
	InputGroup,
	InputGroupAddon,
	InputGroupButton,
	InputGroupTextarea,
} from '@proxy/ui/components/input-group';
import {Message, MessageContent} from '@/components/chat/message';
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
import {useHuman} from '@/hooks/use-human';
import {useOrgSlug} from '@/hooks/use-org';
import {useUnread} from '@/hooks/use-unread';
import {formatAgo, formatDateTime} from '@/lib/format';
import type {Pose} from '@/lib/head';
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

// When the persona was last active: the last thing said, or its making before anything was.
function lastActive(persona: ChatPersona, last: ChatPersona['lastMessage']): number {
	return Date.parse(last?.at ?? persona.createdAt);
}

// The organization's personas in the second sidebar, each with its head, its name and the last
// thing said between it and the person, marked where the person hasn't seen it, the open one lit,
// each head watching the pointer while it is over that agent's row. Pinned ones are compact
// launchers in a grid on top; within each section the one last active is first, the open one by
// its log, so what the person just said moves it up at once.
function PersonaList({
	personas,
	current,
	currentLog,
	takeOpeningPersona,
	rememberOpeningPersona,
	forgetOpeningPersona,
	recallHeadPose,
	rememberHeadPose,
	onEdit,
	onDelete,
	onPin,
}: {
	personas: ChatPersona[];
	current: string;
	currentLog: ThreadLog;
	takeOpeningPersona: () => string | null;
	rememberOpeningPersona: (personaId: string) => void;
	forgetOpeningPersona: (personaId: string) => void;
	recallHeadPose: (personaId: string) => Pose | null;
	rememberHeadPose: (personaId: string, pose: Pose) => void;
	onEdit: (persona: ChatPersona) => void;
	onDelete: (persona: ChatPersona) => void;
	onPin: (persona: ChatPersona) => void;
}) {
	const org = useOrgSlug();
	const unread = useUnread();
	const [hovered, setHovered] = useState(takeOpeningPersona);
	// Whether the persona said something the person hasn't seen, as the provider has it.
	const isUnread = (persona: ChatPersona) =>
		persona.id !== current && unread.unreadIds.has(persona.id);
	const ordered = personas
		.map((persona) => ({
			persona,
			last: persona.id === current ? lastOf(currentLog) : persona.lastMessage,
		}))
		.toSorted((a, b) => lastActive(b.persona, b.last) - lastActive(a.persona, a.last));
	const pinned = ordered.filter(({persona}) => persona.isPinned);
	const unpinned = ordered.filter(({persona}) => !persona.isPinned);
	const menu = (persona: ChatPersona) => (
		<ContextMenuContent>
			<ContextMenuItem onClick={() => onPin(persona)}>
				{persona.isPinned ? <PinOffIcon /> : <PinIcon />}
				{persona.isPinned ? 'Unpin' : 'Pin'}
			</ContextMenuItem>
			{persona.mayChange && (
				<ContextMenuItem onClick={() => onEdit(persona)}>
					<PencilIcon />
					Edit
				</ContextMenuItem>
			)}
			{persona.mayChange && (
				<ContextMenuItem variant="destructive" onClick={() => onDelete(persona)}>
					<Trash2Icon />
					Delete
				</ContextMenuItem>
			)}
		</ContextMenuContent>
	);
	const pinnedCards = pinned.map(({persona}) => {
		const fresh = isUnread(persona);
		return (
			<ContextMenu key={persona.id}>
				<ContextMenuTrigger render={<li className="min-w-0" />}>
					<Link
						to={`/${org}/chat/${persona.id}`}
						aria-current={persona.id === current ? 'page' : undefined}
						onPointerEnter={() => setHovered(persona.id)}
						onPointerLeave={() => {
							setHovered(null);
							forgetOpeningPersona(persona.id);
						}}
						onPointerUp={(event) => {
							if (
								persona.id === current ||
								event.pointerType !== 'mouse' ||
								event.button !== 0 ||
								event.metaKey ||
								event.ctrlKey ||
								event.shiftKey ||
								event.altKey
							) {
								return;
							}
							rememberOpeningPersona(persona.id);
						}}
						className={cn(
							'flex min-w-0 flex-col items-center gap-1 rounded-lg px-1 py-2 text-center hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
							persona.id === current && 'bg-sidebar-accent text-sidebar-accent-foreground',
						)}
					>
						<span className="relative">
							<LiveHead
								look={persona.look}
								color={persona.color}
								size={56}
								watching={hovered === persona.id}
								tracking="head"
								recallPose={() => recallHeadPose(persona.id)}
								rememberPose={(pose) => rememberHeadPose(persona.id, pose)}
							/>
							{fresh && (
								<span
									role="status"
									aria-label="Unread"
									className="absolute right-0 bottom-0 size-2.5 rounded-full border-2 border-sidebar bg-primary"
								/>
							)}
						</span>
						<span title={persona.name} className="w-full truncate text-xs font-medium">
							{persona.name}
						</span>
					</Link>
				</ContextMenuTrigger>
				{menu(persona)}
			</ContextMenu>
		);
	});
	const rows = (listed: typeof ordered) =>
		listed.map(({persona, last}) => {
			const fresh = isUnread(persona);
			const row = (
				<Link
					to={`/${org}/chat/${persona.id}`}
					aria-current={persona.id === current ? 'page' : undefined}
					onPointerEnter={() => setHovered(persona.id)}
					onPointerLeave={() => {
						setHovered(null);
						forgetOpeningPersona(persona.id);
					}}
					onPointerUp={(event) => {
						if (
							persona.id === current ||
							event.pointerType !== 'mouse' ||
							event.button !== 0 ||
							event.metaKey ||
							event.ctrlKey ||
							event.shiftKey ||
							event.altKey
						) {
							return;
						}
						rememberOpeningPersona(persona.id);
					}}
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
						recallPose={() => recallHeadPose(persona.id)}
						rememberPose={(pose) => rememberHeadPose(persona.id, pose)}
					/>
					<span className="flex min-w-0 flex-1 flex-col">
						<span className="flex items-baseline gap-2">
							<span className="min-w-0 flex-1 truncate text-sm font-medium">{persona.name}</span>
							{last && (
								<span className="shrink-0 text-xs text-muted-foreground">{formatAgo(last.at)}</span>
							)}
						</span>
						<span className="flex items-center gap-2">
							<span
								className={cn(
									'min-w-0 flex-1 truncate text-xs',
									fresh ? 'font-medium' : 'text-muted-foreground',
								)}
							>
								{subtitle(last)}
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
				<ContextMenu key={persona.id}>
					<ContextMenuTrigger render={<li />}>{row}</ContextMenuTrigger>
					{menu(persona)}
				</ContextMenu>
			);
		});
	return (
		<div className="flex h-full min-h-0 flex-col overflow-y-auto p-2">
			{personas.length === 0 && (
				<span className="px-2 py-1.5 text-sm text-muted-foreground">No agents yet.</span>
			)}
			{pinned.length > 0 && (
				<ul aria-label="Pinned chats" className="grid grid-cols-3 gap-1 pb-2">
					{pinnedCards}
				</ul>
			)}
			{unpinned.length > 0 && <ul className="flex flex-col gap-0.5">{rows(unpinned)}</ul>}
		</div>
	);
}

type Loaded = Awaited<ReturnType<typeof chatLoader>>;

// The page: the conversation with the persona in its address, started over when the address
// changes, so what one conversation showed never lingers on another.
export function ChatPage() {
	const loaded = useLoaderData<typeof chatLoader>();
	// A mouse click can replace the sidebar before its leave event. Hand that one clicked persona
	// to the replacement list without making ordinary hover rerender the conversation itself.
	const openingPersona = useRef<string | null>(null);
	const headPoses = useRef(new Map<string, Pose>());
	const takeOpeningPersona = useCallback(() => {
		const personaId = openingPersona.current;
		openingPersona.current = null;
		return personaId;
	}, []);
	const rememberOpeningPersona = useCallback((personaId: string) => {
		openingPersona.current = personaId;
	}, []);
	const forgetOpeningPersona = useCallback((personaId: string) => {
		if (openingPersona.current !== personaId) {
			return;
		}
		openingPersona.current = null;
	}, []);
	useEffect(() => {
		openingPersona.current = null;
	}, [loaded.log.persona.id]);
	const recallHeadPose = useCallback(
		(personaId: string) => headPoses.current.get(personaId) ?? null,
		[],
	);
	const rememberHeadPose = useCallback((personaId: string, pose: Pose) => {
		headPoses.current.set(personaId, pose);
	}, []);
	return (
		<Conversation
			key={loaded.log.persona.id}
			loaded={loaded}
			takeOpeningPersona={takeOpeningPersona}
			rememberOpeningPersona={rememberOpeningPersona}
			forgetOpeningPersona={forgetOpeningPersona}
			recallHeadPose={recallHeadPose}
			rememberHeadPose={rememberHeadPose}
		/>
	);
}

// The person's conversation with one of the organization's personas: its log, read again as the
// persona works, and an input. The persona hands each piece of work to a sub-agent it keeps
// talking with, which acts as the person through the organization's built-in login, whose calls
// go through the same gate as any agent's, so its activity is in the log by the sub-agent's task.
function Conversation({
	loaded,
	takeOpeningPersona,
	rememberOpeningPersona,
	forgetOpeningPersona,
	recallHeadPose,
	rememberHeadPose,
}: {
	loaded: Loaded;
	takeOpeningPersona: () => string | null;
	rememberOpeningPersona: (personaId: string) => void;
	forgetOpeningPersona: (personaId: string) => void;
	recallHeadPose: (personaId: string) => Pose | null;
	rememberHeadPose: (personaId: string, pose: Pose) => void;
}) {
	const org = useOrgSlug();
	const human = useHuman();
	const navigate = useNavigate();
	const revalidator = useRevalidator();
	const [log, setLog] = useState<ThreadLog>(loaded.log);
	const [text, setText] = useState('');
	const [sending, setSending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	// The agent dialog: making a new one, or changing the selected one; closed as null.
	const [editing, setEditing] = useState<'new' | ChatPersona | null>(null);
	const [deleting, setDeleting] = useState<ChatPersona | null>(null);
	const form = useRef<HTMLFormElement>(null);
	const personaId = loaded.log.persona.id;
	const current = loaded.log.persona;

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
		void revalidator.revalidate();
	}, [answered, revalidator]);

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
		await readLog();
	};

	// Enter sends; Shift+Enter breaks the line.
	const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
		if (event.key === 'Enter' && !event.shiftKey) {
			event.preventDefault();
			form.current?.requestSubmit();
		}
	};

	// Saves the dialog's persona: a new one, opened; or the selected one, renamed, refaced or
	// switched to another model.
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
		await revalidator.revalidate();
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
		if (persona.id === personaId) {
			void navigate(`/${org}/chat`);
			return;
		}
		await revalidator.revalidate();
	};

	const pinPersona = async (persona: ChatPersona) => {
		const changed = await setPersonaPinned(org, persona.id, !persona.isPinned);
		if (changed.isErr()) {
			setError(describeFetchError(changed.error));
			return;
		}
		await revalidator.revalidate();
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
			title={<PageTitle>{current.name}</PageTitle>}
			actions={<AddButton label="New agent" onClick={() => setEditing('new')} />}
			panel={
				<PersonaList
					personas={loaded.personas}
					current={personaId}
					currentLog={log}
					takeOpeningPersona={takeOpeningPersona}
					rememberOpeningPersona={rememberOpeningPersona}
					forgetOpeningPersona={forgetOpeningPersona}
					recallHeadPose={recallHeadPose}
					rememberHeadPose={rememberHeadPose}
					onEdit={setEditing}
					onDelete={setDeleting}
					onPin={(persona) => void pinPersona(persona)}
				/>
			}
			panelLabel="Agents"
			scroll="inside"
		>
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
									chatModel: editing.chatModel ?? undefined,
								}
					}
					chooseModel={human?.org.insider ?? false}
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
