import type {ChatPersona} from '@proxy/contracts/harness';
import {type ReactNode, useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {useNavigate} from 'react-router';
import {listPersonas, markRead} from '@/client/harness-client';
import {useExperiments} from '@/hooks/use-experiment';
import {useHuman} from '@/hooks/use-human';
import {usePoll} from '@/hooks/use-poll';
import {type Unread, UnreadContext, type Viewing} from '@/hooks/use-unread';
import {desktopBridge} from '@/lib/desktop';
import {notify} from '@/lib/notifications';

// What the organization's agents said that the person hasn't seen, as the api keeps it, asked for
// every so often from every page, when the page comes back into view, and after the person read
// something: the count on the sidebar's Chat, in the window's title and on the desktop app's
// badge, the mark on each conversation in Chat's list, and a notification for what came while the
// person was elsewhere. The Chat page says which conversation it shows, and up to which answer;
// while the person looks at it, in view and in the window they are in, it is neither counted nor
// notified of, and that answer is sent as read. An answer is told of once it has stayed unread a
// moment, asked about again, so a window the person reads it in, another tab or the desktop app,
// has marked it read first.

const POLL_MS = 20 * 1000;
const VISIBLE_POLL_GAP_MS = 5 * 1000;
const CONFIRM_MS = 5 * 1000;

// Whether the person is looking at the page: in view, and in the window they are in.
function isAttending(): boolean {
	return document.visibilityState === 'visible' && document.hasFocus();
}

// An answer first seen unread, at a time, waiting to be told of.
type Waiting = {answerId: string; since: number};

// Whether a poll's personas are the ones kept, so nothing renders anew for them.
function samePersonas(kept: ChatPersona[] | null, listed: ChatPersona[]): boolean {
	return kept !== null && JSON.stringify(kept) === JSON.stringify(listed);
}

export function UnreadProvider({children}: {children: ReactNode}) {
	// The sidebar's organization: the address's, or on the person's account page, their first.
	const org = useHuman()?.org.slug ?? '';
	const navigate = useNavigate();
	const experiments = useExperiments();
	const enabled = org !== '' && experiments.includes('harness');
	const [personas, setPersonas] = useState<ChatPersona[] | null>(null);
	const [viewing, setViewing] = useState<Viewing | null>(null);
	const [attending, setAttending] = useState(isAttending);
	// The conversation the person is looking at, and as the poll, outside render, reads it.
	const looking = attending ? viewing : null;
	const lookingRef = useRef<Viewing | null>(looking);
	useEffect(() => {
		lookingRef.current = looking;
	}, [looking]);
	// What each persona was last told of, by the answer: the first poll only sets this, so a page
	// opened on old news doesn't repeat it, and everything since is told of once.
	const told = useRef<Map<string, string> | null>(null);
	// The answers waiting to be told of, by the persona, and when to ask about them again.
	const waiting = useRef(new Map<string, Waiting>());
	const [confirmAt, setConfirmAt] = useState<number | null>(null);
	// Which poll was asked for last: one asked for before it that answers after it is dropped, so a
	// poll begun before a read can't put back what was unread.
	const latestPoll = useRef(0);
	// Whether the provider is still there: a poll or a read that lands after it is gone is dropped.
	const alive = useRef(true);
	useEffect(() => {
		alive.current = true;
		return () => {
			alive.current = false;
		};
	}, []);

	const poll = useCallback(async () => {
		if (!alive.current) {
			return;
		}
		latestPoll.current += 1;
		const asked = latestPoll.current;
		const result = await listPersonas(org);
		if (!alive.current || asked !== latestPoll.current || result.isErr()) {
			return;
		}
		const listed = result.value.personas;
		setPersonas((kept) => (samePersonas(kept, listed) ? kept : listed));
		const unread = listed.flatMap((persona) =>
			persona.unread && persona.lastAnswer ? [{persona, answer: persona.lastAnswer}] : [],
		);
		const known = told.current;
		if (!known) {
			told.current = new Map(unread.map(({persona, answer}) => [persona.id, answer.id]));
			return;
		}
		const now = Date.now();
		const nextTold = new Map<string, string>();
		const nextWaiting = new Map<string, Waiting>();
		for (const {persona, answer} of unread) {
			if (known.get(persona.id) === answer.id || persona.id === lookingRef.current?.personaId) {
				nextTold.set(persona.id, answer.id);
				continue;
			}
			const before = waiting.current.get(persona.id);
			const since = before?.answerId === answer.id ? before.since : now;
			if (now - since < CONFIRM_MS) {
				nextWaiting.set(persona.id, {answerId: answer.id, since});
				continue;
			}
			nextTold.set(persona.id, answer.id);
			notify(
				{
					title: persona.name,
					body: answer.text,
					path: `/${org}/chat/${persona.id}`,
					tag: persona.id,
					id: answer.id,
				},
				(path) => void navigate(path),
			);
		}
		told.current = nextTold;
		waiting.current = nextWaiting;
		const since = [...nextWaiting.values()].map((answer) => answer.since);
		setConfirmAt(since.length === 0 ? null : Math.min(...since) + CONFIRM_MS);
	}, [org, navigate]);

	useEffect(() => {
		if (confirmAt === null) {
			return;
		}
		const timer = setTimeout(() => void poll(), Math.max(0, confirmAt - Date.now()));
		return () => {
			clearTimeout(timer);
		};
	}, [confirmAt, poll]);

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

	const ask = useCallback(() => void poll(), [poll]);
	usePoll(ask, {enabled, intervalMs: POLL_MS, visibleGapMs: VISIBLE_POLL_GAP_MS, immediate: true});

	// The answer the person is looking at is read: sent once, unless the api already has it read,
	// and asked about again once it lands. One that failed to send is sent again after the next
	// poll.
	const sent = useRef<string | null>(null);
	useEffect(() => {
		if (!enabled || !looking?.answerId) {
			return;
		}
		const {personaId, answerId} = looking;
		const known = personas?.find((persona) => persona.id === personaId);
		const read = known !== undefined && !known.unread && known.lastAnswer?.id === answerId;
		if (read || sent.current === answerId) {
			return;
		}
		sent.current = answerId;
		void markRead(org, personaId, answerId).then((result) => {
			if (result.isErr()) {
				sent.current = null;
				return;
			}
			void poll();
		});
	}, [enabled, org, looking, personas, poll]);

	// A notification clicked in the desktop app opens its conversation.
	useEffect(() => desktopBridge()?.onOpenPath?.((path) => void navigate(path)), [navigate]);

	const lookingAt = looking?.personaId ?? null;
	const unreadIds = useMemo(
		() =>
			new Set(
				(personas ?? [])
					.filter((persona) => persona.unread && persona.id !== lookingAt)
					.map((persona) => persona.id),
			),
		[personas, lookingAt],
	);
	const count = unreadIds.size;

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
		const bridge = desktopBridge();
		bridge?.setBadge?.(count);
		if (count === 0) {
			return;
		}
		return () => {
			bridge?.setBadge?.(0);
		};
	}, [count]);

	const loaded = personas !== null;
	const value = useMemo<Unread>(() => ({loaded, unreadIds, setViewing}), [loaded, unreadIds]);
	return <UnreadContext.Provider value={value}>{children}</UnreadContext.Provider>;
}
