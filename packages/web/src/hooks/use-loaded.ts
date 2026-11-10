import {use, useEffect, useState} from 'react';
import {useLoaderData} from 'react-router';
import {type Later, Redirected} from '@/lib/loader-utils';

type LaterLoader<T> = (...args: never[]) => Later<T>;

/** What a loader answering `later` loads. */
export type LoadedBy<L> = L extends LaterLoader<infer T> ? T : never;

// Never settles: a page being sent elsewhere shows nothing more of its own.
const NEVER = new Promise<never>(() => undefined);

/**
 * What the page's loader loaded, for the content of a page whose loader answers `later`. Until the
 * answer has come the content suspends, the frame around it showing in its place what stands for
 * it (app-shell.tsx), as it does while the frame follows a redirect; a failure is thrown to the
 * frame, which says so. Loaded again after a change, the content stays as it is until the new
 * answer has come.
 */
export function useLoaded<L extends LaterLoader<unknown>>(): LoadedBy<L>;
export function useLoaded<T>(): T {
	// An answer that has come is read at once (`later` marks it settled for `use`), so content drawn
	// after it came is there without a moment of what stands for it. And under React's `act`, in
	// tests, a render that waits on a promise long settled and takes more than one slice of time is
	// left unfinished until the next awaited `act`: a large page then never showed where a click
	// led. `use` is called on every render, the answer come or not: a render that waited and is
	// drawn again once the answer has come calls the same hooks as before.
	const answer = use(useLoaderData<Later<T>>().later);
	if (answer instanceof Redirected) {
		return use(NEVER);
	}
	return answer;
}

type Last<T> = {answer: T | null; pending: boolean};

/**
 * What the page's loader last loaded, for the part of a page that stays up while its content
 * loads, as Chat's list of agents beside the conversation: the last answer that has come, null
 * before any has, the one before it while the next is `pending`. It never suspends, and a failure
 * leaves the last answer as it is, for the content to say.
 */
export function useLastLoaded<L extends LaterLoader<unknown>>(): Last<LoadedBy<L>>;
export function useLastLoaded<T>(): Last<T> {
	const {later} = useLoaderData<Later<T>>();
	// The last answer, and the loading it or its failure ended.
	const [last, setLast] = useState<{answer: T | null; of: Promise<T | Redirected> | null}>({
		answer: null,
		of: null,
	});
	useEffect(() => {
		let left = false;
		later.then(
			(answer) => {
				if (!left && !(answer instanceof Redirected)) {
					setLast({answer, of: later});
				}
			},
			() => {
				if (!left) {
					setLast((before) => ({answer: before.answer, of: later}));
				}
			},
		);
		return () => {
			left = true;
		};
	}, [later]);
	return {answer: last.answer, pending: last.of !== later};
}
