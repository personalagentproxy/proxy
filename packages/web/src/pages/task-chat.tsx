import type {TaskChat, TaskChatEntry} from '@proxy/contracts/harness';
import {ArrowUpIcon} from 'lucide-react';
import {type FormEvent, type KeyboardEvent, useCallback, useEffect, useRef, useState} from 'react';
import {getTask, postTaskMessage} from '@/client/harness-client';
import {Bubble, BubbleContent} from '@/components/chat/bubble';
import {Message, MessageContent} from '@/components/chat/message';
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
import {useLoaded} from '@/hooks/use-loaded';
import {useOrgSlug} from '@/hooks/use-org';
import {useReloadWhileHidden} from '@/hooks/use-reload-on-release';
import {chatRuns} from '@/lib/chat-runs';
import {describeFetchError} from '@/lib/loader-utils';
import type {chatTaskLoader} from '@/loaders';
import {
	InputGroup,
	InputGroupAddon,
	InputGroupButton,
	InputGroupTextarea,
} from '@proxy/ui/components/input-group';

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
// wrote to it, on the right, in a dark one, as they typed it.
function TaskTurn({entry}: {entry: TaskChatEntry}) {
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

// A task the persona started in the person's conversation, in its place, its title heading the
// page (ChatPage): what the persona and the task said to each other, read again as the task
// works, and an input, with which the person writes to the task themselves. The task takes it
// up, and the persona is told, but only woken by what the task answers.
function TaskConversation({loaded}: {loaded: TaskChat}) {
	const org = useOrgSlug();
	const [chat, setChat] = useState<TaskChat>(loaded);
	const [text, setText] = useState('');
	const [sending, setSending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const form = useRef<HTMLFormElement>(null);
	const personaId = loaded.persona.id;
	const taskId = loaded.task.id;
	const {persona, task} = chat;
	const {busy} = chat;
	useReloadWhileHidden(text === '' && !sending);

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

	const send = async (event: FormEvent) => {
		event.preventDefault();
		const message = text.trim();
		if (message === '' || sending) {
			return;
		}
		setSending(true);
		setError(null);
		const posted = await postTaskMessage(org, personaId, taskId, message);
		setSending(false);
		if (posted.isErr()) {
			setError(describeFetchError(posted.error));
			return;
		}
		setText('');
		await readChat();
	};

	// Enter sends; Shift+Enter breaks the line.
	const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
		if (event.key === 'Enter' && !event.shiftKey) {
			event.preventDefault();
			form.current?.requestSubmit();
		}
	};

	const runs = chatRuns(chat.entries, new Date(), (entry) => entry.from);

	return (
		<>
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
				{error && <p className="text-sm text-destructive">{error}</p>}
				<InputGroup className="rounded-xl bg-background shadow-xs">
					<InputGroupTextarea
						value={text}
						onChange={(event) => setText(event.target.value)}
						onKeyDown={onKeyDown}
						placeholder={`Message ${task.title}`}
						aria-label="Message"
						className="min-h-10 p-3"
						rows={1}
					/>
					<InputGroupAddon align="block-end" className="items-end">
						<span className="text-xs text-muted-foreground">
							{persona.name} sees what you write here.
						</span>
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
