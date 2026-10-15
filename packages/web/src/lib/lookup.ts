import type {FetchError} from '@proxy/utils';
import {useEffect, useRef, useState} from 'react';
import type {Result} from 'ts-results-es';

// What a widget has read: the answer for what it asks now, or while that is on its way, the one
// before, so the widget doesn't empty between keystrokes.
export type Lookup<T> = {data: T | null; error: FetchError | null; loading: boolean};

// An answer is read again once it is a minute old, the next time it is asked for.
const FRESH_MS = 60_000;

// How long what is asked must stay the same before it is read: while a name is still being typed,
// "jac" and "jacky tomorro" aren't worth asking a contact book for.
const SETTLE_MS = 250;

type Entry<T> = {at: number; result: Result<T, FetchError>};

/**
 * A hook reading `load` for its arguments once they have stayed the same for a moment, the answers
 * kept by their arguments, so a widget asking the same again while the person types, or another
 * widget asking the same, reads it once. Each
 * call makes one store, of one kind of answer. `null` asks nothing. `clear` drops what is kept,
 * after a write changed it.
 */
export function lookup<A, T>(load: (args: A) => Promise<Result<T, FetchError>>) {
	const cache = new Map<string, Entry<T>>();
	const pending = new Map<string, Promise<Entry<T>>>();

	function read(key: string, args: A): Promise<Entry<T>> {
		const loading =
			pending.get(key) ??
			load(args).then((result) => {
				const entry = {at: Date.now(), result};
				cache.set(key, entry);
				pending.delete(key);
				return entry;
			});
		pending.set(key, loading);
		return loading;
	}

	function useLookup(args: A | null): Lookup<T> {
		const key = args === null ? null : JSON.stringify(args);
		const latest = useRef(args);
		const [shown, setShown] = useState<Entry<T> | null>(null);
		const entry = key === null ? undefined : cache.get(key);

		useEffect(() => {
			latest.current = args;
		});

		useEffect(() => {
			const kept = key === null ? undefined : cache.get(key);
			if (key === null || latest.current === null || (kept && Date.now() - kept.at < FRESH_MS)) {
				return;
			}
			let live = true;
			const args = latest.current;
			const timer = setTimeout(
				() => {
					void read(key, args).then((answer) => {
						if (live) {
							setShown(answer);
						}
					});
				},
				pending.has(key) ? 0 : SETTLE_MS,
			);
			return () => {
				live = false;
				clearTimeout(timer);
			};
		}, [key]);

		const current = entry ?? shown;
		return {
			data: current?.result.isOk() ? current.result.value : null,
			error: current?.result.isErr() ? current.result.error : null,
			loading: key !== null && entry === undefined,
		};
	}

	return Object.assign(useLookup, {clear: () => cache.clear()});
}
