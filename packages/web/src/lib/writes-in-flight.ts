// The writes to the api still on their way, which a reload would cut off.

let writesInFlight = 0;

/** Counts `write` as on its way until it settles; it is returned as it is. */
export function trackWrite<T>(write: Promise<T>): Promise<T> {
	writesInFlight += 1;
	return write.finally(() => {
		writesInFlight -= 1;
	});
}

/** Whether a write is still on its way. */
export function hasWriteInFlight(): boolean {
	return writesInFlight > 0;
}
