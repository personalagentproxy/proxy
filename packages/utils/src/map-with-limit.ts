/** Runs `work` on every item, at most `limit` at once, the results in the items' order. */
export async function mapWithLimit<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
	const results = new Array<R>(items.length);
	// One iterator shared by every worker, so each item is taken once.
	const queue = items.entries();
	const worker = async (): Promise<void> => {
		for (const [index, item] of queue) {
			results[index] = await work(item);
		}
	};
	await Promise.all(Array.from({length: Math.min(limit, items.length)}, worker));
	return results;
}
