import type {ChatPersona} from '@proxy/contracts/harness';
import {type ReactNode, useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {useNavigate} from 'react-router';
import {listPersonas} from '@/client/harness-client';
import {useExperiments} from '@/hooks/use-experiment';
import {useOrgSlug} from '@/hooks/use-org';
import {type Unread, UnreadContext} from '@/hooks/use-unread';
import {desktopBridge} from '@/lib/desktop';
import {notify} from '@/lib/notifications';

// What the organization's agents said that the person hasn't seen, asked for every so often from
// every page, and when the page comes back into view: the count on the sidebar's Chat, in the
// window's title and on the desktop app's badge, the mark on each conversation in Chat's list, and
// a notification for what came while the person was elsewhere. The conversation the Chat page
// shows while it is in view is never unread or notified of: the page marks it read as it reads it.

const POLL_MS = 20 * 1000;
const VISIBLE_POLL_GAP_MS = 5 * 1000;

// Whether the persona said something the person hasn't seen, that a notice would be of.
function unreadFrom(persona: ChatPersona): ChatPersona['lastMessage'] {
	if (!persona.unread || persona.lastMessage?.kind !== 'assistant') {
		return null;
	}
	return persona.lastMessage;
}

export function UnreadProvider({children}: {children: ReactNode}) {
	const org = useOrgSlug();
	const navigate = useNavigate();
	const experiments = useExperiments();
	const enabled = org !== '' && experiments.includes('harness');
	const [personas, setPersonas] = useState<ChatPersona[] | null>(null);
	const [open, setOpenState] = useState<string | null>(null);
	// The open conversation as the poll, outside render, reads it.
	const openRef = useRef<string | null>(null);
	const setOpen = useCallback((personaId: string | null) => {
		openRef.current = personaId;
		setOpenState(personaId);
	}, []);
	// What each persona was last told of, by the message: the first answer only sets this, so a
	// page opened on old news doesn't repeat it, and everything since is told of once.
	const told = useRef<Map<string, string> | null>(null);

	const poll = useCallback(async () => {
		const result = await listPersonas(org);
		if (result.isErr()) {
			return;
		}
		const listed = result.value.personas;
		setPersonas(listed);
		const known = told.current;
		told.current = new Map(
			listed.flatMap((persona) => {
				const last = unreadFrom(persona);
				return last ? [[persona.id, last.id] as const] : [];
			}),
		);
		if (!known) {
			return;
		}
		for (const persona of listed) {
			const last = unreadFrom(persona);
			if (!last || persona.id === openRef.current || known.get(persona.id) === last.id) {
				continue;
			}
			notify(
				{title: persona.name, body: last.text, path: `/${org}/chat/${persona.id}`},
				persona.id,
				(path) => void navigate(path),
			);
		}
	}, [org, navigate]);

	useEffect(() => {
		if (!enabled) {
			return;
		}
		let lastPoll = Date.now();
		const ask = () => {
			lastPoll = Date.now();
			void poll();
		};
		const onVisible = () => {
			if (document.visibilityState !== 'visible' || Date.now() - lastPoll < VISIBLE_POLL_GAP_MS) {
				return;
			}
			ask();
		};
		ask();
		const timer = setInterval(ask, POLL_MS);
		document.addEventListener('visibilitychange', onVisible);
		window.addEventListener('focus', onVisible);
		return () => {
			clearInterval(timer);
			document.removeEventListener('visibilitychange', onVisible);
			window.removeEventListener('focus', onVisible);
		};
	}, [enabled, poll]);

	// A notification clicked in the desktop app opens its conversation.
	useEffect(() => desktopBridge()?.onOpenPath?.((path) => void navigate(path)), [navigate]);

	const markSeen = useCallback((personaId: string) => {
		setPersonas((current) => {
			if (!current?.some((persona) => persona.id === personaId && persona.unread)) {
				return current;
			}
			return current.map((persona) =>
				persona.id === personaId ? {...persona, unread: false} : persona,
			);
		});
	}, []);

	const unreadIds = useMemo(
		() =>
			new Set(
				(personas ?? [])
					.filter((persona) => persona.unread && persona.id !== open)
					.map((persona) => persona.id),
			),
		[personas, open],
	);
	const count = unreadIds.size;

	// The count in the window's title and on the desktop app's badge, while there is one.
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

	const value = useMemo<Unread>(
		() => ({loaded: personas !== null, unreadIds, count, setOpen, markSeen}),
		[personas, unreadIds, count, setOpen, markSeen],
	);
	return <UnreadContext.Provider value={value}>{children}</UnreadContext.Provider>;
}
