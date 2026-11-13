// The api's own words for a refusal, when it has them: a value a column doesn't take, a statement
// that isn't one that reads, a web page that couldn't be read.
export function apiMessage(body: unknown): string | null {
	if (typeof body !== 'object' || body === null || !('message' in body)) {
		return null;
	}
	return typeof body.message === 'string' && body.message !== '' ? body.message : null;
}
