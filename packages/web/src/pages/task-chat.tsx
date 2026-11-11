import type {TaskChat, TaskChatEntry} from '@proxy/contracts/harness';
import {
	type FormEvent,
	type KeyboardEvent,
	memo,
	useCallback,
	useEffect,
	useRef,
	useState,
} from 'react';
import {getTask, postTaskMessage} from '@/client/harness-client';
import {Bubble, BubbleContent} from '@/components/chat/bubble';
import {Message, MessageContent} from '@/components/chat/message';
import {
	MessageScroller,
	MessageScrollerButton,
	MessageScrollerContent,
	MessageScrollerItem,
	MessageScrollerViewport,
} from '@/components/chat/message-scroller';
import {WorkingLine} from '@/components/chat/task-line';
import {Head} from '@/components/head';
import {Markdown} from '@/components/markdown';
import {PillButton} from '@proxy/ui/components/pill-button';
import {useLoaded} from '@/hooks/use-loaded';
import {useOrgSlug} from '@/hooks/use-org';
import {useReloadWhileHidden} from '@/hooks/use-reload-on-release';
import {useSending} from '@/hooks/use-sending';
import {keepEntries, sameJson} from '@/lib/chat-log';
import {chatRuns} from '@/lib/chat-runs';
import {describeFetchError} from '@/lib/loader-utils';
import type {chatTaskLoader} from '@/loaders';
import {InputGroup, InputGroupAddon, InputGroupTextarea} from '@proxy/ui/components/input-group';

// How often the chat is read again while the task is at work, and while it is not.
const BUSY_POLL_MS = 1000;
const IDLE_POLL_MS = 4000;

// Who a stretch of the chat is from, over its first message: the persona, with its head, the
// person, or the task.
function RunLabel({from, chat}: {from: TaskChatEntry['from']; chat: TaskChat}) {
	if (from === 'persona') {
		return (
			<span className="flex items-center gap-1.5 self-end text-xs font-medium text-muted-foreground">
				<Head look={chat.persona.look} color={chat.persona.color} size={16} />
				{chat.persona.name}
			</span>
		);
	}
	if (from === 'person') {
		return <span className="self-end text-xs font-medium text-muted-foreground">You</span>;
	}
	return <span className="text-xs font-medium text-muted-foreground">{chat.task.title}</span>;
}

// One message of the chat: what the task said, on the left, in a gray bubble, a red one where it
// failed; what the persona said to it, on the right, in an outlined one; and what the person
// wrote to it, on the right, in a dark one, as they typed it. It is drawn again only as it
// changes, since drawing it parses its Markdown; one that came while the chat was open rises into
// place.
const TaskTurn = memo(function TaskTurn({entry, fresh}: {entry: TaskChatEntry; fresh: boolean}) {
	return (
		<div data-enter={fresh ? 'rise' : undefined}>
			<TaskTurnBubble entry={entry} />
		</div>
	);
});

function TaskTurnBubble({entry}: {entry: TaskChatEntry}) {
	if (entry.from === 'person') {
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
	if (entry.from === 'persona') {
		return (
			<Message align="end">
				<MessageContent>
					<Bubble align="end" variant="outline">
						<BubbleContent>
							<Markdown text={entry.text} />
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

/** The task the address names, once loaded: started over when the address names another. */
export function OpenTask() {
	const {task} = useLoaded<typeof chatTaskLoader>();
	return <TaskConversation key={task.task.id} loaded={task} />;
}

// What the person wrote in a message of the chat; null for one that isn't theirs.
function personText(entry: TaskChatEntry): string | null {
	return entry.from === 'person' ? entry.text : null;
}

// A task the persona started in the person's conversation, in its place, its title heading the
// page (ChatPage): what the persona and the task said to each other, read again as the task
// works, and an input, with which the person writes to the task themselves. The task takes it
// up, and the persona is told, but only woken by what the task answers. What the person writes
// shows at once, before the server has it.
function TaskConversation({loaded}: {loaded: TaskChat}) {
	const org = useOrgSlug();
	const [chat, setChat] = useState<TaskChat>(loaded);
	const personaId = loaded.persona.id;
	const taskId = loaded.task.id;
	const {persona, task} = chat;
	const sending = useSending(chat.entries, personText);
	const busy = chat.busy || sending.waiting;
	// What the chat had as it opened: what comes after it rises into place.
	const [opened] = useState(() => new Set(loaded.entries.map((entry) => entry.id)));

	// Which read of the chat was asked for last: one asked for before it that answers after it is
	// dropped, so a poll begun before a send can't put back the chat as it was without the message.
	// A read that brings nothing new changes nothing, and what didn't change is kept as it was.
	const latestRead = useRef(0);
	const readChat = useCallback(async () => {
		latestRead.current += 1;
		const read = latestRead.current;
		const result = await getTask(org, personaId, taskId);
		if (read !== latestRead.current || result.isErr()) {
			return;
		}
		const after = result.value;
		setChat((before) =>
			sameJson(before, after)
				? before
				: {...after, entries: keepEntries(before.entries, after.entries)},
		);
	}, [org, personaId, taskId]);

	useEffect(() => {
		const timer = setInterval(() => void readChat(), busy ? BUSY_POLL_MS : IDLE_POLL_MS);
		return () => {
			clearInterval(timer);
		};
	}, [readChat, busy]);

	// Sends what the person wrote, shown at once and taken away again where the send fails: what
	// it failed with, or null. The server answers with no entry: the chat read again brings it, by
	// its text.
	const send = async (message: string): Promise<string | null> => {
		const key = `sending-${crypto.randomUUID()}`;
		sending.start({
			id: key,
			from: 'person',
			text: message,
			isError: false,
			at: new Date().toISOString(),
		});
		const posted = await postTaskMessage(org, personaId, taskId, message);
		if (posted.isErr()) {
			sending.failed(key);
			return describeFetchError(posted.error);
		}
		sending.posted(key, null);
		await readChat();
		return null;
	};

	const runs = chatRuns(sending.entries, new Date(), (entry) => entry.from);

	return (
		<>
			<MessageScroller className="min-h-0 flex-1">
				<MessageScrollerViewport aria-label="Task">
					<MessageScrollerContent className="page-column mx-auto w-full max-w-3xl pt-6 pb-4">
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
										<RunLabel from={first.from} chat={chat} />
										{run.entries.map((entry) => {
											const entryKey = sending.keyOf(entry);
											return (
												<TaskTurn key={entryKey} entry={entry} fresh={!opened.has(entryKey)} />
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
			<TaskComposer
				placeholder={`Message ${task.title}`}
				hint={`${persona.name} sees what you write here.`}
				onSend={send}
			/>
		</>
	);
}

// The input under a task's chat. What is typed is its own, so typing draws the input, not the
// chat over it. A message sent leaves the input at once, and comes back to it where the send
// fails.
function TaskComposer({
	placeholder,
	hint,
	onSend,
}: {
	placeholder: string;
	hint: string;
	// Sends a message: what it failed with, or null.
	onSend: (message: string) => Promise<string | null>;
}) {
	const [text, setText] = useState('');
	// What is in the box now, as a send that waited on the server finds it.
	const typedNow = useRef('');
	const [sending, setSending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const form = useRef<HTMLFormElement>(null);
	useReloadWhileHidden(text === '' && !sending);

	const type = (value: string) => {
		setText(value);
		typedNow.current = value;
	};

	// The message leaves the box at once; where the send fails, it comes back, before anything
	// typed since.
	const submit = async (event: FormEvent) => {
		event.preventDefault();
		const message = text.trim();
		if (message === '' || sending) {
			return;
		}
		setSending(true);
		setError(null);
		type('');
		const failed = await onSend(message);
		setSending(false);
		if (failed === null) {
			return;
		}
		setError(failed);
		const since = typedNow.current;
		type(since === '' ? text : `${text}\n${since}`);
	};

	// Enter sends; Shift+Enter breaks the line.
	const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
		if (event.key === 'Enter' && !event.shiftKey) {
			event.preventDefault();
			form.current?.requestSubmit();
		}
	};

	return (
		<form
			ref={form}
			onSubmit={(event) => void submit(event)}
			className="page-column mx-auto flex w-full max-w-3xl shrink-0 flex-col gap-2 pt-2 pb-4"
		>
			{error && <p className="text-sm text-destructive">{error}</p>}
			<InputGroup className="rounded-xl bg-background shadow-xs">
				<InputGroupTextarea
					value={text}
					onChange={(event) => type(event.target.value)}
					onKeyDown={onKeyDown}
					placeholder={placeholder}
					aria-label="Message"
					className="min-h-10 p-3"
					rows={1}
				/>
				<InputGroupAddon align="block-end" className="items-end">
					<span className="text-xs text-muted-foreground">{hint}</span>
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
	);
}
