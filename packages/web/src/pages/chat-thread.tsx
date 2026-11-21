import type {
	ChatAttachment,
	ChatHarness,
	ThreadMessage,
	ThreadView,
} from '@proxy/contracts/harness';
import {memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState} from 'react';
import {useParams} from 'react-router';
import {
	getChatThread,
	replyInThread,
	saveThreadDraft,
	setThreadModel,
	uploadThreadAttachment,
} from '@/client/harness-client';
import {ShownFile} from '@/components/chat/attachments';
import {Bubble, BubbleContent} from '@/components/chat/bubble';
import {Composer, type ComposerModel} from '@/components/chat/composer';
import {CopyButton} from '@/components/copy-button';
import {Message, MessageContent} from '@/components/chat/message';
import {
	MessageScroller,
	MessageScrollerButton,
	MessageScrollerContent,
	MessageScrollerItem,
	MessageScrollerViewport,
} from '@/components/chat/message-scroller';
import {FileViewer, type ViewedFile} from '@/components/chat/file-viewer';
import {
	AlertsLine,
	EventLine,
	PersonBubble,
	SubAgentLine,
	TimeMarker,
} from '@/components/chat/thread-parts';
import {WorkingLine} from '@/components/chat/working-line';
import {type ImageOf, Markdown} from '@/components/markdown';
import type {AttachmentInput} from '@/hooks/use-attachments';
import {type LoadedBy, useAnswer} from '@/hooks/use-loaded';
import {useOrgSlug} from '@/hooks/use-org';
import {useSending} from '@/hooks/use-sending';
import {useThreadDraft} from '@/hooks/use-chat-draft';
import {useUnread} from '@/hooks/use-unread';
import {keepEntries, sameJson} from '@/lib/chat-log';
import {describeApiError, type Later} from '@/lib/loader-utils';
import {marksTime} from '@/lib/thread-time';
import type {chatThreadLoader} from '@/loaders';
import {markdownPictures, readFileLink} from '@proxy/utils/file-links';
import {cn} from '@proxy/ui/lib/utils';

// How often an open thread is read again while it is at work, and while it is not: a reply, or a
// wake-up, shows within a moment either way.
const BUSY_POLL_MS = 1000;
const IDLE_POLL_MS = 4000;

/** What the Chat page gives the thread open beside its chat, besides what its route loads. */
export type ThreadContext = {
	harnesses: ChatHarness[];
	// An agent is being made, changed or deleted in a dialog.
	managing: boolean;
	// The thread as it is shown, for the title bar, the list beside it and what is read; null once
	// it is closed.
	onShown: (view: ThreadView | null) => void;
	// Whether the address names a thread the chat doesn't have, for the title bar, which would
	// wait for its name otherwise.
	onMissing: (missing: boolean) => void;
};

// The file kept with an answer that a link of it names; undefined for any other link.
function keptFile(attachments: ChatAttachment[], src: string): ChatAttachment | undefined {
	const target = readFileLink(src, window.location.origin);
	return attachments.find(
		(candidate) =>
			candidate.connectionId === target?.connectionId && candidate.fileId === target.fileId,
	);
}

// The pictures an answer shows, in the order its words put them, for the viewer: each of its
// Markdown pictures that links to a picture kept with it.
function picturesOf(message: ThreadMessage): ViewedFile[] {
	return markdownPictures(message.text).flatMap(({src, alt}) => {
		const attachment = keptFile(message.attachments, src);
		return attachment?.shown === true && !attachment.gone ? [{attachment, alt}] : [];
	});
}

// An answer's pictures as tiles, each opening the viewer at itself; any other link as it is.
function AnswerMarkdown({message}: {message: ThreadMessage}) {
	const [viewing, setViewing] = useState<number | null>(null);
	const pictures = useMemo(() => picturesOf(message), [message]);
	const image: ImageOf | null =
		message.attachments.length === 0
			? null
			: (src, alt) => {
					const attachment = keptFile(message.attachments, src);
					if (attachment === undefined) {
						return null;
					}
					const at = pictures.findIndex((picture) => picture.attachment === attachment);
					return (
						<ShownFile
							attachment={attachment}
							alt={alt}
							onOpen={() => setViewing(Math.max(at, 0))}
						/>
					);
				};
	return (
		<>
			<Markdown text={message.text} image={image} />
			{pictures.length > 0 && <FileViewer files={pictures} index={viewing} onIndex={setViewing} />}
		</>
	);
}

// Something said in the thread: what the person said, on the left, in a grey bubble; what the
// persona answered, or told them as it went, as plain Markdown, without a bubble, in a red one
// where its turn failed; or an event, a quiet line. It is drawn again only as it changes, since
// drawing an answer parses its Markdown; one that came while the thread was open rises into place.
const Said = memo(function Said({message, fresh}: {message: ThreadMessage; fresh: boolean}) {
	return <div data-enter={fresh ? 'rise' : undefined}>{saidPart(message)}</div>;
});

function saidPart(message: ThreadMessage) {
	if (message.kind === 'person') {
		return (
			<PersonBubble
				text={message.text}
				attachments={message.attachments}
				passedOn={message.passedOn}
			/>
		);
	}
	if (message.subAgent) {
		return (
			<SubAgentOpener
				id={message.subAgent.id}
				title={message.subAgent.title}
				working={message.subAgent.working}
			/>
		);
	}
	if (message.kind === 'event') {
		return <EventLine line={message.line ?? message.text} text={message.text} />;
	}
	return (
		<Message>
			<MessageContent>
				<Bubble variant={message.isError ? 'destructive' : 'ghost'}>
					<BubbleContent>
						<AnswerMarkdown message={message} />
					</BubbleContent>
				</Bubble>
			</MessageContent>
		</Message>
	);
}

// The thread's messages as they are drawn: each on its own, but sub-agent lines one after another
// together, close as a list rather than apart as messages.
function runsOf(messages: ThreadMessage[]): [ThreadMessage, ...ThreadMessage[]][] {
	const runs: [ThreadMessage, ...ThreadMessage[]][] = [];
	for (const message of messages) {
		const last = runs.at(-1);
		if (last && message.subAgent !== undefined && last.at(-1)?.subAgent !== undefined) {
			last.push(message);
			continue;
		}
		runs.push([message]);
	}
	return runs;
}

// A sub-agent's line, opening its thread beside the chat as any thread of it opens.
function SubAgentOpener({id, title, working}: {id: string; title: string; working: boolean}) {
	const {org = '', id: personaId = ''} = useParams();
	return (
		<SubAgentLine
			title={title}
			working={working}
			to={`/${org}/chat/${personaId}/threads/${encodeURIComponent(id)}`}
		/>
	);
}

/** The route of a thread of a chat, whose answer the Chat page reads (router.tsx). */
export const THREAD_ROUTE = 'chat-thread';

/** What a thread's route loads (`chatThreadLoader`). */
export type ThreadLoad = Later<LoadedBy<typeof chatThreadLoader>>['later'];

/**
 * The thread the address names, beside its chat, once loaded: started over when the address names
 * another. The Chat page draws it from what the thread's route loads, rather than in the route's
 * place, in the column beside its list of tasks (app-shell.tsx's `Side`).
 */
export function OpenThread({later, ...context}: ThreadContext & {later: ThreadLoad}) {
	const {thread} = useAnswer(later);
	if (thread === null) {
		return <MissingThread onMissing={context.onMissing} />;
	}
	return <Thread key={thread.thread.id} loaded={thread} {...context} />;
}

// In place of a thread the chat doesn't have: the page is told so while this says it.
function MissingThread({onMissing}: Pick<ThreadContext, 'onMissing'>) {
	useLayoutEffect(() => {
		onMissing(true);
		return () => onMissing(false);
	}, [onMissing]);
	return (
		<p className="px-5 pt-6 text-sm text-muted-foreground">This thread does not exist anymore.</p>
	);
}

// What the person may be asked to send in a thread, when its agent behaves oddly, for the thread's
// id: caught here, never sent, so neither the server nor the agent sees it. Not offered anywhere.
const TRACE_COMMAND = '/trace';

// Whether a reply is the trace command and nothing else.
function isTrace(message: string, files: ChatAttachment[]): boolean {
	return files.length === 0 && message.trim() === TRACE_COMMAND;
}

// The thread's id, as a reply of /trace shows it, to be copied and passed on.
function ThreadIdLine({id}: {id: string}) {
	return (
		<div
			data-enter="rise"
			className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground"
		>
			<span>Thread id</span>
			<code className="min-w-0 truncate rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
				{id}
			</code>
			<CopyButton value={id} label="Copy thread id" />
		</div>
	);
}

// What the person said in the thread; null for what isn't theirs.
function personText(message: ThreadMessage): string | null {
	return message.kind === 'person' ? message.text : null;
}

// Nothing to take out on the server: a thread's box is the page's alone.
function keepNothing() {}

// One of the chat's threads: everything said in it, read again as it works, at its end the alerts
// that come to it, as a line to the Alerts page showing them, and a box to reply in, which has the
// keyboard's focus as it opens; the check that says it is done is in its cell of the
// title bar (chat-page.tsx). What the person replies shows at once, the persona at work under
// it, before the server has it.
function Thread({
	loaded,
	harnesses,
	managing,
	onShown,
}: Omit<ThreadContext, 'onMissing'> & {loaded: ThreadView}) {
	const org = useOrgSlug();
	const {refresh: refreshUnread} = useUnread();
	const [view, setView] = useState<ThreadView>(loaded);
	const personaId = loaded.persona.id;
	const threadId = loaded.thread.id;
	const sending = useSending(view.messages, personText);
	// What is typed in its box and not sent, kept on the server as the chat's is, without its files.
	const draft = useThreadDraft(org, personaId, threadId, loaded.draft ?? '');
	const busy = view.busy || sending.waiting;
	// Read often while its agent runs; a thread asleep, at work though it is, is read as one stopped
	// is, which a sleep of hours would otherwise have read every second.
	const running = sending.waiting || (view.busy && view.thread.state.kind !== 'asleep');
	// What the thread had as it opened: what comes after it rises into place.
	const [opened] = useState(() => new Set(loaded.messages.map((message) => message.id)));
	const [focusRequested, setFocusRequested] = useState(true);
	// The times /trace was sent here since the thread opened, each shown as the thread's id.
	const [traces, setTraces] = useState<string[]>([]);
	const focused = useCallback(() => setFocusRequested(false), []);

	// The thread as the page loads it again, as after a change of the persona, keeping
	// what didn't change as it was.
	const [seen, setSeen] = useState(loaded);
	if (seen !== loaded) {
		setSeen(loaded);
		setView((before) =>
			sameJson(before, loaded)
				? before
				: {...loaded, messages: keepEntries(before.messages, loaded.messages)},
		);
	}

	// The page is told of the thread as it is shown, what was just replied in it included, and
	// that it is closed as it goes, before the next one says it is shown.
	const shown = useMemo(() => ({...view, messages: sending.entries}), [view, sending.entries]);
	useLayoutEffect(() => {
		onShown(shown);
	}, [onShown, shown]);
	useLayoutEffect(() => () => onShown(null), [onShown]);

	// Which read of the thread was asked for last: one asked for before it that answers after it is
	// dropped, so a poll begun before a reply can't put back the thread as it was without it. A
	// read that brings nothing new changes nothing, and what didn't change is kept as it was.
	const latestRead = useRef(0);
	const readThread = useCallback(async () => {
		latestRead.current += 1;
		const read = latestRead.current;
		const result = await getChatThread(org, personaId, threadId);
		if (read !== latestRead.current || result.isErr()) {
			return;
		}
		const after = result.value;
		setView((before) =>
			sameJson(before, after)
				? before
				: {...after, messages: keepEntries(before.messages, after.messages)},
		);
	}, [org, personaId, threadId]);

	useEffect(() => {
		const timer = setInterval(() => void readThread(), running ? BUSY_POLL_MS : IDLE_POLL_MS);
		return () => {
			clearInterval(timer);
		};
	}, [readThread, running]);

	// Sends what the person replies, with the files placed among it, shown at once and taken away
	// again where the send fails, once `settle` has: what it failed with, or null.
	const send = async (
		message: string,
		files: ChatAttachment[],
		settle: () => Promise<void>,
	): Promise<string | null> => {
		if (isTrace(message, files)) {
			// Kept from the server: only a draft of it saved as it was typed is forgotten there.
			await settle();
			if (draft.saved !== '') {
				await saveThreadDraft(org, personaId, threadId, '');
			}
			setTraces((before) => [...before, `trace-${crypto.randomUUID()}`]);
			return null;
		}
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
		const posted = await replyInThread(org, personaId, threadId, message, files);
		if (posted.isErr()) {
			sending.failed(key);
			return describeApiError(posted.error);
		}
		sending.posted(key, posted.value.message.id);
		// The reply read the thread: it is unread no more in the lists.
		refreshUnread();
		await readThread();
		return null;
	};

	// What runs the thread: its persona's as it was opened, switched here by the person, whose
	// thread it is, from its next turn on, the persona and its other threads left as they are.
	const model: ComposerModel = {
		chosen: view.model,
		mayChange: true,
		onSwitch: async (choice) => {
			const switched = await setThreadModel(org, personaId, threadId, choice);
			if (switched.isErr()) {
				return describeApiError(switched.error);
			}
			await readThread();
			return null;
		},
	};

	// Where a file put in the box goes: up to the person's own drive.
	const input = useMemo(
		(): AttachmentInput => ({
			upload: (file) => uploadThreadAttachment(org, personaId, threadId, file),
			remove: keepNothing,
		}),
		[org, personaId, threadId],
	);

	// Laid out as a new task's box is: its column as wide at most, and as far in from the edges.
	const column = 'page-column mx-auto max-w-4xl';

	return (
		<>
			<MessageScroller className="min-h-0 flex-1">
				<MessageScrollerViewport aria-label="Thread">
					<MessageScrollerContent className={cn('w-full gap-4.5 pt-6 pb-4', column)}>
						{runsOf(sending.entries).map((run, index, runs) => {
							const key = sending.keyOf(run[0]);
							return (
								<MessageScrollerItem key={key} scrollAnchor={run.some(sending.sentHere)}>
									{marksTime(runs[index - 1]?.at(-1)?.at, run[0].at) && (
										<TimeMarker at={run[0].at} />
									)}
									{run.length === 1 ? (
										<Said message={run[0]} fresh={!opened.has(key)} />
									) : (
										<div className="flex flex-col gap-1.5">
											{run.map((message) => (
												<Said
													key={sending.keyOf(message)}
													message={message}
													fresh={!opened.has(sending.keyOf(message))}
												/>
											))}
										</div>
									)}
								</MessageScrollerItem>
							);
						})}
						{traces.map((key) => (
							<MessageScrollerItem key={key} scrollAnchor>
								<ThreadIdLine id={threadId} />
							</MessageScrollerItem>
						))}
						{busy && (
							<MessageScrollerItem>
								<div data-enter="fade">
									<WorkingLine />
								</div>
							</MessageScrollerItem>
						)}
						{view.thread.alerts > 0 && (
							<MessageScrollerItem>
								<AlertsLine
									count={view.thread.alerts}
									to={`/${org}/alerts?thread=${encodeURIComponent(threadId)}`}
								/>
							</MessageScrollerItem>
						)}
					</MessageScrollerContent>
				</MessageScrollerViewport>
				<MessageScrollerButton />
			</MessageScroller>
			<Composer
				persona={view.persona}
				harnesses={harnesses}
				model={model}
				label="Reply"
				placeholder="Reply"
				input={input}
				keptFiles={[]}
				openingText={loaded.draft ?? ''}
				kept={draft}
				managing={managing}
				focusRequested={focusRequested}
				onFocused={focused}
				onSend={send}
				className={column}
			/>
		</>
	);
}
