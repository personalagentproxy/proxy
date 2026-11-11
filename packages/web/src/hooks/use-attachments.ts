import {type ChatAttachment, MAX_ATTACHMENTS} from '@proxy/contracts/harness';
import type {FetchError} from '@proxy/utils';
import {useCallback, useRef, useState} from 'react';
import type {Result} from 'ts-results-es';
import {describeApiError} from '@/lib/loader-utils';

/** A file in the conversation's input, to go with the next message: on its way up, there, or failed, saying why. */
export type PendingAttachment = {
	key: number;
	name: string;
	size: number;
	attachment: ChatAttachment | null;
	error: string | null;
};

/**
 * Where an input's files go: up to the person's own drive, and out of the input again, where the
 * server keeps the input (the conversation's does; a task's is the page's alone).
 */
export type AttachmentInput = {
	upload: (file: File) => Promise<Result<{attachment: ChatAttachment}, FetchError>>;
	remove: (attachment: ChatAttachment) => void;
};

/**
 * The files in a conversation's or a task's input, put there by the button, a paste or a drop:
 * each is uploaded at once, to the person's own drive, and, in a conversation, kept in the input
 * by the server, as what is typed is kept as the draft, so the conversation opens with those put
 * there before (`kept`), on any device. They go with the message sent next, each where it sits among the words
 * (components/chat/message-editor.tsx), and the send empties the input on the server itself. One
 * that failed stays, saying why, until it is taken out; one taken out is taken out on the server
 * too, as one is that was taken out while still on its way up, once it has landed. What was put
 * there beyond the most a message carries is left out, and said.
 */
export function useAttachments(input: AttachmentInput, kept: ChatAttachment[]) {
	const nextKey = useRef(kept.length);
	const [pending, setPending] = useState<PendingAttachment[]>(() =>
		kept.map((attachment, index) => ({
			key: index + 1,
			name: attachment.name,
			size: attachment.size,
			attachment,
			error: null,
		})),
	);
	const [refused, setRefused] = useState<string | null>(null);

	// How many are in the input now, read where files are added: two adds in one moment, as a
	// paste and a drop, each see what the other took.
	const held = useRef(kept.length);
	// Those taken out while still on their way up, by their keys.
	const takenOut = useRef(new Set<number>());

	const add = useCallback(
		(files: File[]) => {
			const room = Math.max(0, MAX_ATTACHMENTS - held.current);
			setRefused(
				files.length > room ? `A message carries at most ${MAX_ATTACHMENTS} files.` : null,
			);
			const taken = files.slice(0, room).map((file) => {
				nextKey.current += 1;
				return {key: nextKey.current, file};
			});
			held.current += taken.length;
			setPending((before) => [
				...before,
				...taken.map(({key, file}) => ({
					key,
					name: file.name,
					size: file.size,
					attachment: null,
					error: null,
				})),
			]);
			for (const {key, file} of taken) {
				void input.upload(file).then((uploaded) => {
					if (uploaded.isOk() && takenOut.current.delete(key)) {
						input.remove(uploaded.value.attachment);
						return;
					}
					setPending((now) =>
						now.map((one) => {
							if (one.key !== key) {
								return one;
							}
							if (uploaded.isErr()) {
								return {...one, error: describeApiError(uploaded.error)};
							}
							return {...one, attachment: uploaded.value.attachment};
						}),
					);
				});
			}
		},
		[input],
	);
	const remove = useCallback(
		(one: PendingAttachment) => {
			held.current = Math.max(0, held.current - 1);
			setPending((before) => before.filter((other) => other.key !== one.key));
			if (one.attachment !== null) {
				input.remove(one.attachment);
				return;
			}
			if (one.error === null) {
				takenOut.current.add(one.key);
			}
		},
		[input],
	);
	// After a send, which emptied the input on the server.
	const sent = useCallback(() => {
		held.current = 0;
		setPending([]);
	}, []);

	return {
		pending,
		refused,
		add,
		remove,
		sent,
		// Whether any is still on its way up: the message waits for it.
		uploading: pending.some((one) => one.attachment === null && one.error === null),
	};
}
