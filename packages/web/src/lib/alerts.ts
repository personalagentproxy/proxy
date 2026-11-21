import type {Alert} from '@proxy/contracts/alerts';

// Where an alert comes, as the Alerts page and its dialog show it.

/** Where an alert comes, in a few words, under its title: its thread, by its title, or a new thread each time, in Slack for one set in a thread there. */
export function threadOf(alert: Alert): string {
	if (alert.thread === null) {
		return alert.opensInSlack ? 'New thread in Slack each time' : 'New thread each time';
	}
	return `In “${alert.thread.title || 'Thread'}”`;
}

/** The address of the thread an alert comes to, in its agent's chat, for one in Chat; the chat's for one that opens a new thread each time. One in Slack is linked there instead (components/chat/thread-link.tsx). */
export function threadTo(org: string, alert: Alert): string {
	const chat = `/${org}/chat/${alert.persona.id}`;
	return alert.thread === null ? chat : `${chat}/threads/${alert.thread.id}`;
}
