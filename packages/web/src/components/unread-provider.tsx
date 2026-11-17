import type {ChatAnswer} from '@proxy/contracts/harness';
import type {FetchError} from '@proxy/utils';
import {type ReactNode, useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {useNavigate} from 'react-router';
import {listAnswers, markRead} from '@/client/harness-client';
import {useOrgSlug} from '@/hooks/use-org';
import {usePoll} from '@/hooks/use-poll';
import {type Unread, UnreadContext, type Viewing} from '@/hooks/use-unread';
import {desktopBridge} from '@/lib/desktop';
import {notify} from '@/lib/notifications';

// What the organization's agents said that the person hasn't seen, thread by thread, as the api
// keeps it, asked for every so often from every page, when the page comes back into view, and
// after the person read something: the count of threads whose turn ended with an answer the
// person hasn't opened them to see, the threads the Chat page marks, on the sidebar's Chat, in the
// window's title and on the desktop app's badge, as on each conversation in Chat's list; the mark
// on a conversation whose only news is from a thread at work; and a notification for what came
// while the person was elsewhere: one for each thread whose turn ended with an answer they haven't
// seen, by what it said last, rather than one at each thing said in it. The Chat page says which
// conversation it shows, and which thread's answer; while the person looks at it, in view and in
// the window they are in, the conversation is not notified of, as they see its threads end there,
// and the answer is sent as read, which reads its thread up to it. A thread's answer is told of
// once it has stayed unread a moment, asked about again, so a window the person reads it in,
// another tab or the desktop app, has marked it read first.

const POLL_MS = 20 * 1000;
const VISIBLE_POLL_GAP_MS = 5 * 1000;
// How long an answer stays unread before it is told of: past what the Chat page takes to show it
// and send it as read, in the window the person reads it in, as it reads the chat again every 4
// seconds while a thread of it is in progress, and at once when an answer this provider found
// isn't in it (pages/chat-page.tsx).
const CONFIRM_MS = 5 * 1000;

// Whether a read that failed may land sent again: not one the api refused, as for an answer or a
// persona gone, which never will.
function mayLandLater(error: FetchError): boolean {
	return (
		error.kind !== 'http' || error.status >= 500 || error.status === 408 || error.status === 429
	);
}

// Whether the person is looking at the page: in view, and in the window they are in.
function isAttending(): boolean {
	return document.visibilityState === 'visible' && document.hasFocus();
}

// An answer first seen unread, at a time, waiting to be told of.
type Waiting = {answerId: string; since: number};

// Whether a poll's answers are the ones kept, so nothing renders anew for them.
function sameAnswers(kept: ChatAnswer[] | null, listed: ChatAnswer[]): boolean {
	return kept !== null && JSON.stringify(kept) === JSON.stringify(listed);
}

export function UnreadProvider({children}: {children: ReactNode}) {
	const org = useOrgSlug();
	const navigate = useNavigate();
	const enabled = org !== '';
	const [answers, setAnswers] = useState<ChatAnswer[] | null>(null);
	const [viewing, setViewing] = useState<Viewing | null>(null);
	const [attending, setAttending] = useState(isAttending);
	// The conversation the person is looking at, and as the poll, outside render, reads it.
	const looking = attending ? viewing : null;
	const lookingRef = useRef<Viewing | null>(looking);
	useEffect(() => {
		lookingRef.current = looking;
	}, [looking]);
	// What each thread was last told of, by the answer: the first poll only sets this, so a page
	// opened on old news doesn't repeat it, and everything since is told of once.
	const told = useRef<Map<string, string> | null>(null);
	// The answers waiting to be told of, by the thread, and when to ask about them again.
	const waiting = useRef(new Map<string, Waiting>());
	// How long from the poll that found them, each poll's own, so the wait is timed from what the
	// poll saw rather than from whenever the timer is set.
	const [confirmIn, setConfirmIn] = useState<{ms: number} | null>(null);
	// Which poll was asked for last: one asked for before it that answers after it is dropped, so a
	// poll begun before a read can't put back what was unread.
	const latestPoll = useRef(0);
	// A read that failed, sent again once a poll lands, by bumping this.
	const resendAfterPoll = useRef(false);
	const [resends, setResends] = useState(0);

	const poll = useCallback(
		async (signal: AbortSignal) => {
			latestPoll.current += 1;
			const asked = latestPoll.current;
			const result = await listAnswers(org);
			if (signal.aborted || asked !== latestPoll.current || result.isErr()) {
				return;
			}
			const listed = result.value.answers;
			setAnswers((kept) => (sameAnswers(kept, listed) ? kept : listed));
			if (resendAfterPoll.current) {
				resendAfterPoll.current = false;
				setResends((count) => count + 1);
			}
			const ended = listed.flatMap(({personaId, name, unread}) =>
				unread
					.filter((thread) => thread.ended)
					.map(({threadId, answer}) => ({personaId, name, threadId, answer})),
			);
			const known = told.current;
			if (!known) {
				told.current = new Map(ended.map(({threadId, answer}) => [threadId, answer.id]));
				return;
			}
			const now = Date.now();
			const looked = lookingRef.current;
			const nextTold = new Map<string, string>();
			const nextWaiting = new Map<string, Waiting>();
			for (const {personaId, name, threadId, answer} of ended) {
				// One that ends while the person looks at its conversation they see end there, marked.
				if (known.get(threadId) === answer.id || looked?.personaId === personaId) {
					nextTold.set(threadId, answer.id);
					continue;
				}
				const before = waiting.current.get(threadId);
				const since = before?.answerId === answer.id ? before.since : now;
				if (now - since < CONFIRM_MS) {
					nextWaiting.set(threadId, {answerId: answer.id, since});
					continue;
				}
				nextTold.set(threadId, answer.id);
				notify(
					{
						title: name,
						body: answer.text,
						path: `/${org}/chat/${personaId}`,
						tag: threadId,
						id: answer.id,
					},
					(path) => void navigate(path),
				);
			}
			told.current = nextTold;
			waiting.current = nextWaiting;
			const since = [...nextWaiting.values()].map((waited) => waited.since);
			setConfirmIn(since.length === 0 ? null : {ms: Math.min(...since) + CONFIRM_MS - now});
		},
		[org, navigate],
	);

	const ask = useCallback((signal: AbortSignal) => void poll(signal), [poll]);
	const askNow = usePoll(ask, {
		enabled,
		intervalMs: POLL_MS,
		visibleGapMs: VISIBLE_POLL_GAP_MS,
		immediate: true,
	});

	useEffect(() => {
		if (confirmIn === null) {
			return;
		}
		const timer = setTimeout(askNow, Math.max(0, confirmIn.ms));
		return () => {
			clearTimeout(timer);
		};
	}, [confirmIn, askNow]);

	useEffect(() => {
		const onChange = () => setAttending(isAttending());
		document.addEventListener('visibilitychange', onChange);
		window.addEventListener('focus', onChange);
		window.addEventListener('blur', onChange);
		return () => {
			document.removeEventListener('visibilitychange', onChange);
			window.removeEventListener('focus', onChange);
			window.removeEventListener('blur', onChange);
		};
	}, []);

	// The answer the person is looking at is read, and its thread up to it: sent once the first
	// poll has said whether the api has it read already, unless it has, and asked about again once
	// it lands. One that failed to send is sent again after the next poll, unless the api refused it.
	const sent = useRef<string | null>(null);
	useEffect(() => {
		if (!enabled || !answers || !looking?.answerId) {
			return;
		}
		const {personaId, threadId, answerId} = looking;
		const unread = answers
			.find((answer) => answer.personaId === personaId)
			?.unread.some((thread) => thread.threadId === threadId && thread.answer.id === answerId);
		if (!unread || sent.current === answerId) {
			return;
		}
		sent.current = answerId;
		void markRead(org, personaId, answerId).then((result) => {
			if (result.isErr()) {
				if (mayLandLater(result.error)) {
					sent.current = null;
					resendAfterPoll.current = true;
				}
				return;
			}
			askNow();
		});
	}, [enabled, org, looking, answers, askNow, resends]);

	// A notification clicked in the desktop app opens its conversation.
	useEffect(() => desktopBridge()?.onOpenPath?.((path) => void navigate(path)), [navigate]);

	const unreadIds = useMemo(
		() =>
			new Set(
				(answers ?? [])
					.filter((answer) => answer.unread.length > 0)
					.map((answer) => answer.personaId),
			),
		[answers],
	);
	const count = (answers ?? []).reduce(
		(sum, answer) => sum + answer.unread.filter((thread) => thread.ended).length,
		0,
	);

	// The count in the window's title and on the desktop app's badge, while there is one, and
	// while the provider is there: signed out, the badge has no count.
	useEffect(() => {
		const title = document.title;
		if (count === 0) {
			return;
		}
		document.title = `(${count}) ${title}`;
		return () => {
			document.title = title;
		};
	}, [count]);
	useEffect(() => {
		desktopBridge()?.setBadge?.(count);
	}, [count]);
	useEffect(
		() => () => {
			desktopBridge()?.setBadge?.(0);
		},
		[],
	);

	const value = useMemo<Unread>(
		() => ({count, unreadIds, answers, setViewing, refresh: askNow}),
		[count, unreadIds, answers, askNow],
	);
	return <UnreadContext.Provider value={value}>{children}</UnreadContext.Provider>;
}
