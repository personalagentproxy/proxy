import type {Alert} from '@proxy/contracts/alerts';

// Where an alert comes, as the Alerts page and its dialog show it.

/** Where an alert comes, in a few words, under its title: its thread, by its title, or a new thread each time. */
export function threadOf(alert: Alert): string {
	if (alert.thread === null) {
		return 'New thread each time';
	}
	return `In “${alert.thread.title || 'Thread'}”`;
}

/** The address of the thread an alert comes to, in its agent's chat; the chat's for one that opens a new thread each time. */
export function threadTo(org: string, alert: Alert): string {
	const chat = `/${org}/chat/${alert.persona.id}`;
	return alert.thread === null ? chat : `${chat}/threads/${alert.thread.id}`;
}
