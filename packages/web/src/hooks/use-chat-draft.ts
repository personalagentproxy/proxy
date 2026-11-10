import type {ChatAttachment} from '@proxy/contracts/harness';
import {useCallback, useEffect, useRef, useState} from 'react';
import {saveDraft} from '@/client/harness-client';

// What the person types to a persona, kept on the server as they type, so it is there when they
// come back, on any device: a moment after they stop, and at once as the page goes out of view,
// closes, or opens another conversation. One save at a time, in the order typed. A send forgets
// the draft on the server itself, so what was typed for it is not saved, and a save still on its
// way is waited for first, so it can't land after the send and bring the draft back.

// How long after the last keystroke what is typed is saved.
const SAVE_AFTER_MS = 700;

// The most a save sent as the page closes may carry: the browser allows such a call 64 KiB.
const KEEPALIVE_MAX_BYTES = 60_000;

export type ChatDraft = {
	// What the server keeps, as far as the page knows: what is typed is saved when it is this.
	saved: string;
	// The person typed `text`, with `files` sitting among the words where its marks are.
	typed: (text: string, files?: ChatAttachment[]) => void;
	// Before a send: what is typed is not saved, and a save on its way has landed.
	settle: () => Promise<void>;
	// After a send, which forgot the draft on the server.
	sent: () => void;
};

export function useChatDraft(org: string, personaId: string, initial: string): ChatDraft {
	const [saved, setSaved] = useState(initial);
	// Typed, and not yet saved, with the files among the words.
	const pending = useRef<{text: string; files?: ChatAttachment[]} | null>(null);
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	// The saves, one after another.
	const queue = useRef<Promise<void>>(Promise.resolve());
	// Whether a save was begun since the last settle, which a send then has to undo.
	const savedSinceSettle = useRef(false);

	const save = useCallback(
		(text: string, closing: boolean, files?: ChatAttachment[]) => {
			savedSinceSettle.current = true;
			const keepalive = closing && new TextEncoder().encode(text).length <= KEEPALIVE_MAX_BYTES;
			queue.current = queue.current.then(async () => {
				const result = await saveDraft(org, personaId, text, {keepalive, files});
				if (result.isOk()) {
					setSaved(text);
				}
			});
		},
		[org, personaId],
	);

	const stopTimer = () => {
		if (timer.current === null) {
			return;
		}
		clearTimeout(timer.current);
		timer.current = null;
	};

	const flush = useCallback(
		(closing: boolean) => {
			stopTimer();
			const typed = pending.current;
			pending.current = null;
			if (typed === null) {
				return;
			}
			save(typed.text, closing, typed.files);
		},
		[save],
	);

	const typed = useCallback(
		(text: string, files?: ChatAttachment[]) => {
			pending.current = {text, files};
			stopTimer();
			timer.current = setTimeout(() => flush(false), SAVE_AFTER_MS);
		},
		[flush],
	);

	const settle = useCallback(async () => {
		stopTimer();
		pending.current = null;
		savedSinceSettle.current = false;
		await queue.current;
	}, []);

	const sent = useCallback(() => {
		stopTimer();
		pending.current = null;
		setSaved('');
		// Typed while the send was on its way, and saved after it: forgotten as the send forgot it.
		if (savedSinceSettle.current) {
			save('', false);
		}
	}, [save]);

	// Saved at once as the page goes out of view or closes, and as the conversation does.
	useEffect(() => {
		const onHidden = () => {
			if (document.visibilityState === 'hidden') {
				flush(true);
			}
		};
		const onPageHide = () => flush(true);
		document.addEventListener('visibilitychange', onHidden);
		window.addEventListener('pagehide', onPageHide);
		return () => {
			document.removeEventListener('visibilitychange', onHidden);
			window.removeEventListener('pagehide', onPageHide);
			flush(true);
		};
	}, [flush]);

	return {saved, typed, settle, sent};
}
