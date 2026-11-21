import type {SlackThreadRow} from '@proxy/db/harness';

/**
 * A thread that lives in Slack, as a link that opens it there: Slack's web client at the thread,
 * under its root message in the DM, which offers to open it in the Slack app; or, for one whose
 * root message the app has yet to post, at the DM, where it is to be. It is made
 * from what is kept of the thread's place, without asking Slack: the documented link to a message
 * (chat.getPermalink) is on the workspace's own domain, which isn't kept, and would be a call per
 * thread in every list.
 */
export function slackThreadUrl(thread: SlackThreadRow): string {
	const {teamId, channel, rootTs} = thread;
	const dm = `https://app.slack.com/client/${encodeURIComponent(teamId)}/${encodeURIComponent(channel)}`;
	if (rootTs === null) {
		return dm;
	}
	return `${dm}/thread/${encodeURIComponent(`${channel}-${rootTs}`)}`;
}
