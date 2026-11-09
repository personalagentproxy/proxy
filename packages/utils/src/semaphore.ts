/**
 * A cap on how many of something run at once: `run` waits its turn where `limit` are under way,
 * then runs the work and lets the next waiting in as it ends, however it ends. For what a process
 * can only afford so many of, such as turns of a harness that is a subprocess each.
 */
export type Semaphore = {run: <T>(work: () => Promise<T>) => Promise<T>};

export function semaphore(limit: number): Semaphore {
	let running = 0;
	const waiting: Array<() => void> = [];
	const acquire = (): Promise<void> => {
		if (running < limit) {
			running += 1;
			return Promise.resolve();
		}
		return new Promise((resolve) => {
			waiting.push(() => {
				running += 1;
				resolve();
			});
		});
	};
	const release = (): void => {
		running -= 1;
		waiting.shift()?.();
	};
	return {
		run: async (work) => {
			await acquire();
			try {
				return await work();
			} finally {
				release();
			}
		},
	};
}
