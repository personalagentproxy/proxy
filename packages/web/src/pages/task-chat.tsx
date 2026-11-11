import type {ChatAttachment, TaskChat, TaskChatEntry} from '@proxy/contracts/harness';
import {PaperclipIcon} from 'lucide-react';
import {Fragment, type FormEvent, useCallback, useEffect, useMemo, useRef, useState} from 'react';
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
	MessageScrollerProvider,
	MessageScrollerViewport,
} from '@/components/chat/message-scroller';
import {WorkingLine} from '@/components/chat/task-line';
import {Head} from '@/components/head';
import {Markdown} from '@/components/markdown';
import {PillButton} from '@proxy/ui/components/pill-button';
import {
	type AttachmentInput,
	type PendingAttachment,
	useAttachments,
} from '@/hooks/use-attachments';
import {useExperiments} from '@/hooks/use-experiment';
import {useLoaded} from '@/hooks/use-loaded';
import {useOrgSlug} from '@/hooks/use-org';
import {useReloadWhileHidden} from '@/hooks/use-reload-on-release';
import {useWindowFileDrop} from '@/hooks/use-window-file-drop';
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

// One message of the chat: what the task said, on the left, in a gray bubble, a red one where it
// failed; what the persona said to it, on the right, in an outlined one; and what the person
// wrote to it, on the right, in a dark one, as they typed it, with the files they attached where
// they put them.
function TaskTurn({entry}: {entry: TaskChatEntry}) {
	if (entry.from === 'person') {
		return (
			<Message align="end">
				<MessageContent>
					<Bubble align="end" variant="inverted">
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

// A task the persona started in the person's conversation, in its place, its title heading the
// page (ChatPage): what the persona and the task said to each other, read again as the task
// works, and an input, with which the person writes to the task themselves, files attached as
// in the conversation. The task takes it up, and the persona is told, but only woken by what the
// task answers.
function TaskConversation({loaded}: {loaded: TaskChat}) {
	const org = useOrgSlug();
	const [chat, setChat] = useState<TaskChat>(loaded);
	const [text, setText] = useState('');
	// The files among what is typed, in the order they sit there, each where its mark is.
	const [placed, setPlaced] = useState<ChatAttachment[]>([]);
	const [sending, setSending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const form = useRef<HTMLFormElement>(null);
	const editor = useRef<MessageEditorHandle>(null);
	const personaId = loaded.persona.id;
	const taskId = loaded.task.id;
	const {persona, task} = chat;
	const {busy} = chat;
	// Files go to the person's own drive as they are put in; the page holds them until the
	// message is sent, and one taken out stays in the drive, as it does from a conversation's.
	const attaches = useExperiments().includes('files');
	const input = useMemo(
		(): AttachmentInput => ({
			upload: (file) => uploadTaskAttachment(org, personaId, taskId, file),
			remove: () => undefined,
		}),
		[org, personaId, taskId],
	);
	const attachments = useAttachments(input, []);
	const [opening] = useState<{text: string; files: PendingAttachment[]}>({text: '', files: []});
	useReloadWhileHidden(text === '' && attachments.pending.length === 0 && !sending);

	// Which read of the chat was asked for last: one asked for before it that answers after it is
	// dropped, so a poll begun before a send can't put back the chat as it was without the message.
	const latestRead = useRef(0);
	const readChat = useCallback(async () => {
		latestRead.current += 1;
		const read = latestRead.current;
		const result = await getTask(org, personaId, taskId);
		if (read !== latestRead.current || result.isErr()) {
			return;
		}
		setChat(result.value);
	}, [org, personaId, taskId]);

	useEffect(() => {
		const timer = setInterval(() => void readChat(), busy ? BUSY_POLL_MS : IDLE_POLL_MS);
		return () => {
			clearInterval(timer);
		};
	}, [readChat, busy]);

	const type = (typed: Typed) => {
		setText(typed.text);
		setPlaced(typed.files);
	};

	const picker = useRef<HTMLInputElement>(null);
	// A file that could not be uploaded says why under the chat, by its name.
	const failedFile = attachments.pending.find((one) => one.error !== null);
	const failed = failedFile ? `${failedFile.name}: ${failedFile.error ?? ''}` : null;
	const words = text.replaceAll(ATTACHMENT_MARK, '').trim();
	const sendable = !attachments.uploading && (words !== '' || placed.length > 0);
	// Files dropped anywhere on the window are attached.
	const dropping = useWindowFileDrop(attaches, attachments.add);

	const send = async (event: FormEvent) => {
		event.preventDefault();
		if (!sendable || sending) {
			return;
		}
		setSending(true);
		setError(null);
		const posted = await postTaskMessage(org, personaId, taskId, text.trim(), placed);
		setSending(false);
		if (posted.isErr()) {
			setError(describeApiError(posted.error));
			return;
		}
		attachments.sent();
		editor.current?.clear();
		setText('');
		setPlaced([]);
		await readChat();
	};

	const runs = chatRuns(chat.entries, new Date(), (entry) => entry.from);

	return (
		<>
			{dropping && <DropToAttach name={task.title} />}
			<MessageScrollerProvider autoScroll defaultScrollPosition="end">
				<MessageScroller className="min-h-0 flex-1">
					<MessageScrollerViewport aria-label="Task">
						<MessageScrollerContent className="page-column mx-auto w-full max-w-3xl pt-6 pb-4">
							{runs.map((run) => {
								const first = run.entries[0];
								if (!first) {
									return null;
								}
								return (
									<MessageScrollerItem
										key={first.id}
										messageId={first.id}
										scrollAnchor={first.from === 'person'}
										className="flex flex-col gap-4"
									>
										{run.heading !== null && (
											<h2 className="text-center text-xs font-medium text-muted-foreground">
												{run.heading}
											</h2>
										)}
										<div className="flex flex-col gap-2">
											<RunLabel from={first.from} chat={chat} />
											{run.entries.map((entry) => (
												<TaskTurn key={entry.id} entry={entry} />
											))}
										</div>
									</MessageScrollerItem>
								);
							})}
							{busy && (
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
				{(error ?? attachments.refused ?? failed) && (
					<p className="text-sm text-destructive">{error ?? attachments.refused ?? failed}</p>
				)}
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
				<InputGroup className="rounded-xl bg-background shadow-xs">
					<MessageEditor
						ref={editor}
						opening={opening}
						files={attachments.pending}
						label="Message"
						placeholder={`Message ${task.title}`}
						onChange={type}
						onRemove={attachments.remove}
						onFiles={attaches ? attachments.add : undefined}
						onSubmit={() => form.current?.requestSubmit()}
					/>
					<InputGroupAddon align="block-end" className="items-end">
						<span className="text-xs text-muted-foreground">
							{persona.name} sees what you write here.
						</span>
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
		</>
	);
}
