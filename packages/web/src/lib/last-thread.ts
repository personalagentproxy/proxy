import {Result} from 'ts-results-es';
import {z} from 'zod';

// The thread each of an organization's chats last had open beside it, kept in this browser, so
// opening an agent's chat again goes back to that thread; one closed there, or archived, leaves
// the chat to open by itself.
const keyOf = (org: string) => `proxy.last-thread.${org}`;

const storedSchema = z.record(z.string(), z.string());

function stored(org: string): Record<string, string> {
	const raw = Result.wrap(() => localStorage.getItem(keyOf(org)));
	if (raw.isErr() || !raw.value) {
		return {};
	}
	const parsed = Result.wrap(() => storedSchema.safeParse(JSON.parse(raw.value as string)));
	return parsed.isOk() && parsed.value.success ? parsed.value.data : {};
}

/** Keeps the thread open in the chat with the persona, or that none is where null. */
export function rememberLastThread(org: string, personaId: string, threadId: string | null) {
	const before = stored(org);
	if ((before[personaId] ?? null) === threadId) {
		return;
	}
	const {[personaId]: _, ...others} = before;
	const next = threadId === null ? others : {...others, [personaId]: threadId};
	Result.wrap(() => localStorage.setItem(keyOf(org), JSON.stringify(next)));
}

export function lastThread(org: string, personaId: string): string | null {
	return stored(org)[personaId] ?? null;
}

/** Where opening the chat with the persona goes: the thread it last had open, or the chat. */
export function personaChatPath(org: string, personaId: string): string {
	const chat = `/${org}/chat/${personaId}`;
	const threadId = lastThread(org, personaId);
	return threadId === null ? chat : `${chat}/threads/${threadId}`;
}
