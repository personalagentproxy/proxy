import {useCallback, useEffect, useRef} from 'react';

// Something asked of the server every so often, and when the page comes back into view, if it
// has not just been asked.

export type PollOptions = {
	enabled: boolean;
	intervalMs: number;
	// How long after the last ask the page coming back into view asks again.
	visibleGapMs: number;
	// Whether to ask at once, rather than an interval in.
	immediate: boolean;
};

/**
 * Calls `ask` on that schedule while enabled. Its signal is aborted when the schedule stops, as
 * when the component unmounts, so an answer that comes after is dropped. Returns a function that
 * asks at once, off the schedule, with the same signal; it does nothing while the schedule is
 * stopped.
 */
export function usePoll(
	ask: (signal: AbortSignal) => void,
	{enabled, intervalMs, visibleGapMs, immediate}: PollOptions,
): () => void {
	const askNow = useRef<() => void>(() => undefined);
	useEffect(() => {
		if (!enabled) {
			return;
		}
		const stopped = new AbortController();
		let lastAsk = Date.now();
		const run = () => {
			lastAsk = Date.now();
			ask(stopped.signal);
		};
		const onVisible = () => {
			if (document.visibilityState !== 'visible' || Date.now() - lastAsk < visibleGapMs) {
				return;
			}
			run();
		};
		askNow.current = run;
		if (immediate) {
			run();
		}
		const timer = setInterval(run, intervalMs);
		document.addEventListener('visibilitychange', onVisible);
		window.addEventListener('focus', onVisible);
		return () => {
			stopped.abort();
			askNow.current = () => undefined;
			clearInterval(timer);
			document.removeEventListener('visibilitychange', onVisible);
			window.removeEventListener('focus', onVisible);
		};
	}, [ask, enabled, intervalMs, visibleGapMs, immediate]);
	return useCallback(() => askNow.current(), []);
}
