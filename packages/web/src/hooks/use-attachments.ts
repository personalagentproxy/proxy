import {type ChatAttachment, MAX_ATTACHMENTS} from '@proxy/contracts/harness';
import {useCallback, useRef, useState} from 'react';
import {uploadAttachment} from '@/client/harness-client';
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
 * The files the person put in a conversation's input, by the button, a paste or a drop: each is
 * uploaded at once, to their own drive, and goes with the message they send next, in the order
 * they were put there. One that failed stays, saying why, until it is taken out; what was put
 * there beyond the most a message carries is left out, and said.
 */
export function useAttachments(org: string, personaId: string) {
	const [pending, setPending] = useState<PendingAttachment[]>([]);
	const [refused, setRefused] = useState<string | null>(null);
	const nextKey = useRef(0);

	// How many are in the input now, read where files are added: two adds in one moment, as a
	// paste and a drop, each see what the other took.
	const held = useRef(0);

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
				void uploadAttachment(org, personaId, file).then((uploaded) => {
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
		[org, personaId],
	);
	const remove = useCallback((key: number) => {
		held.current = Math.max(0, held.current - 1);
		setPending((before) => before.filter((one) => one.key !== key));
	}, []);
	const clear = useCallback(() => {
		held.current = 0;
		setPending([]);
	}, []);

	return {
		pending,
		refused,
		add,
		remove,
		clear,
		// Those that are there, to send; and whether any is still on its way.
		ready: pending.flatMap((one) => (one.attachment === null ? [] : [one.attachment])),
		uploading: pending.some((one) => one.attachment === null && one.error === null),
	};
}
