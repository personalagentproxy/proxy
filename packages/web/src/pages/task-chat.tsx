import type {ChatAttachment, TaskChat, TaskChatEntry} from '@proxy/contracts/harness';
import {PaperclipIcon} from 'lucide-react';
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
import {getTask, postTaskMessage, uploadTaskAttachment} from '@/client/harness-client';
import {DropToAttach, SentChip} from '@/components/chat/attachments';
import {Bubble, BubbleContent} from '@/components/chat/bubble';
import {Message, MessageContent} from '@/components/chat/message';
import {
	MessageEditor,
	type MessageEditorHandle,
	type Typed,
} from '@/components/chat/message-editor';
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
import {type AttachmentInput, takenFiles, useAttachments} from '@/hooks/use-attachments';
import {useExperiments} from '@/hooks/use-experiment';
import {useLoaded} from '@/hooks/use-loaded';
import {useOrgSlug} from '@/hooks/use-org';
import {useReloadWhileHidden} from '@/hooks/use-reload-on-release';
import {useSending} from '@/hooks/use-sending';
import {useWindowFileDrop} from '@/hooks/use-window-file-drop';
import {keepEntries, sameJson} from '@/lib/chat-log';
import {chatRuns} from '@/lib/chat-runs';
import {describeApiError} from '@/lib/loader-utils';
import type {chatTaskLoader} from '@/loaders';
import {attachedParts, ATTACHMENT_MARK} from '@proxy/utils/harness';
import {InputGroup, InputGroupAddon} from '@proxy/ui/components/input-group';
import {cn} from '@proxy/ui/lib/utils';

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

// One message of the chat: what the task said, on the left, as plain text, in a red bubble where
// it failed; what the persona said to it, on the right, in an outlined one; and what the person
// wrote to it, on the right, in a gray one, as they typed it, with the files they attached where
// they put them. It is drawn again only as it
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
				<Bubble variant={entry.isError ? 'destructive' : 'ghost'}>
					<BubbleContent>
						<Markdown text={entry.text} />
					</BubbleContent>
				</Bubble>
			</MessageContent>
		</Message>
	);
}

/** The task the address names, once loaded: started over when the address names another. */
export function OpenTask({listError}: {listError: string | null}) {
	const {task} = useLoaded<typeof chatTaskLoader>();
	return <TaskConversation key={task.task.id} loaded={task} listError={listError} />;
}

// What the person wrote in a message of the chat; null for one that isn't theirs.
function personText(entry: TaskChatEntry): string | null {
	return entry.from === 'person' ? entry.text : null;
}

// A task the persona started in the person's conversation, in its place, its title heading the
// page (ChatPage): what the persona and the task said to each other, read again as the task
// works, and an input, with which the person writes to the task themselves, files attached as
// in the conversation. The task takes it up, and the persona is told, but only woken by what the
// task answers. What the person writes shows at once, before the server has it.
function TaskConversation({loaded, listError}: {loaded: TaskChat; listError: string | null}) {
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

	// Sends what the person wrote, with the files placed among it, shown at once and taken away
	// again where the send fails: what it failed with, or null. The server answers with no entry:
	// the chat read again brings it, by its text.
	const send = async (message: string, files: ChatAttachment[]): Promise<string | null> => {
		const key = `sending-${crypto.randomUUID()}`;
		sending.start({
			id: key,
			from: 'person',
			text: message,
			isError: false,
			at: new Date().toISOString(),
			attachments: files,
		});
		const posted = await postTaskMessage(org, personaId, taskId, message, files);
		if (posted.isErr()) {
			sending.failed(key);
			return describeApiError(posted.error);
		}
		sending.posted(key, null);
		await readChat();
		return null;
	};

	// Where a file put in the input goes: up to the person's own drive.
	const upload = useCallback(
		(file: File) => uploadTaskAttachment(org, personaId, taskId, file),
		[org, personaId, taskId],
	);

	const runs = chatRuns(sending.entries, new Date(), (entry) => entry.from);

	return (
		<>
			<MessageScroller className="min-h-0 flex-1">
				<MessageScrollerViewport aria-label="Task">
					<MessageScrollerContent className="page-column mx-auto w-full max-w-4xl pt-6 pb-4">
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
										{/* The task's turns, without a bubble apiece, stand further apart than the
										    paragraphs within one. */}
										<div className={cn('flex flex-col', first.from === 'task' ? 'gap-5' : 'gap-2')}>
											{run.entries.map((entry) => {
												const entryKey = sending.keyOf(entry);
												return (
													<TaskTurn key={entryKey} entry={entry} fresh={!opened.has(entryKey)} />
												);
											})}
										</div>
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
				name={task.title}
				hint={`${persona.name} sees what you write here.`}
				upload={upload}
				onSend={send}
				listError={listError}
			/>
		</>
	);
}

// The input under a task's chat. What is typed is its own, so typing draws the input, not the
// chat over it. A message sent leaves the input at once, its files with it, and comes back to it
// where the send fails. Files go to the person's own drive as they are put in; the page holds them
// until the message is sent, and one taken out stays in the drive, as it does from a
// conversation's.
function TaskComposer({
	name,
	hint,
	upload,
	onSend,
	listError,
}: {
	// What the task is called, which the input is a message to.
	name: string;
	hint: string;
	upload: AttachmentInput['upload'];
	// Sends a message, with the files placed among it: what it failed with, or null.
	onSend: (message: string, files: ChatAttachment[]) => Promise<string | null>;
	// What changing the Chat sidebar failed with.
	listError: string | null;
}) {
	const attaches = useExperiments().includes('files');
	const input = useMemo((): AttachmentInput => ({upload, remove: () => undefined}), [upload]);
	const attachments = useAttachments(input, []);
	// The files in the input now, as a send that waited on the server finds them.
	const pendingNow = useRef(attachments.pending);
	useLayoutEffect(() => {
		pendingNow.current = attachments.pending;
	});
	// What the box opens holding: nothing, or, made again where a send failed (`made` times),
	// what the send gave back.
	const [box, setBox] = useState<{
		made: number;
		text: string;
		files: typeof attachments.pending;
	}>({made: 0, text: '', files: []});
	// What is typed, with a mark where each file sits among the words, and those files in the
	// order of their marks (message-editor.tsx).
	const [text, setText] = useState('');
	const [placed, setPlaced] = useState<ChatAttachment[]>([]);
	// What is in the box now, as a send that waited on the server finds it.
	const typedNow = useRef<Typed>({text: '', files: []});
	const [sending, setSending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const form = useRef<HTMLFormElement>(null);
	const editor = useRef<MessageEditorHandle>(null);
	useReloadWhileHidden(text === '' && attachments.pending.length === 0 && !sending);

	// The box made again, where a send failed, keeps the caret.
	useEffect(() => {
		if (box.made > 0) {
			editor.current?.focus();
		}
	}, [box.made]);

	const type = (typed: Typed) => {
		setText(typed.text);
		setPlaced(typed.files);
		typedNow.current = typed;
	};

	const picker = useRef<HTMLInputElement>(null);
	// A file that could not be uploaded says why under the chat, by its name.
	const failedFile = attachments.pending.find((one) => one.error !== null);
	const failedUpload = failedFile ? `${failedFile.name}: ${failedFile.error ?? ''}` : null;
	const words = text.replaceAll(ATTACHMENT_MARK, '').trim();
	const sendable = !attachments.uploading && (words !== '' || placed.length > 0);
	// Files dropped anywhere on the window are attached.
	const dropping = useWindowFileDrop(attaches, attachments.add);

	// The message leaves the box at once, its files with it; where the send fails, it comes back,
	// before anything typed since.
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
		type({text: '', files: []});
		const failed = await onSend(message, files);
		setSending(false);
		if (failed === null) {
			return;
		}
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
	};

	const shownError = error ?? attachments.refused ?? failedUpload ?? listError;

	return (
		<form
			ref={form}
			onSubmit={(event) => void submit(event)}
			className="page-column mx-auto flex w-full max-w-4xl shrink-0 flex-col gap-2 pt-2 pb-4"
		>
			{dropping && <DropToAttach name={name} />}
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
					placeholder={`Message ${name}`}
					onChange={type}
					onRemove={attachments.remove}
					onFiles={attaches ? attachments.add : undefined}
					onSubmit={() => form.current?.requestSubmit()}
				/>
				<InputGroupAddon align="block-end" className="items-end">
					<span className="text-xs text-muted-foreground">{hint}</span>
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
