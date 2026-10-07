/**
 * Counts events per key in a sliding window, in this process's memory: enough for one api
 * instance, and reset when it restarts. Several instances would each count on their own.
 */
export function createRateLimiter(options: {limit: number; windowMs: number}) {
	const events = new Map<string, number[]>();

	function recent(key: string, now: number): number[] {
		const kept = (events.get(key) ?? []).filter((at) => now - at < options.windowMs);
		if (kept.length === 0) {
			events.delete(key);
			return kept;
		}
		events.set(key, kept);
		return kept;
	}

	return {
		/** True while the key has had fewer than `limit` events in the window. */
		allows(key: string, now = Date.now()): boolean {
			return recent(key, now).length < options.limit;
		},
		record(key: string, now = Date.now()): void {
			events.set(key, [...recent(key, now), now]);
		},
	};
}
