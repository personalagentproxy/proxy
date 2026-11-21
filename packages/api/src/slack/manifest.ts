/**
 * The manifest a shared persona's Slack app is made from (https://docs.slack.dev/reference/app-manifest),
 * and its version: the app keeps the version it was last made or updated with, and one older
 * than `SLACK_MANIFEST_VERSION` is out of date, for whoever may change the persona to update. Raise
 * the version with any change to what `slackManifest` makes, so every app already in Slack is
 * offered it.
 */
export const SLACK_MANIFEST_VERSION = 1;

/**
 * What the bot may do, and no more: read the direct messages members send it, which is how its
 * DM's messages come to us as events (`im:history`); post its answers in their threads, which the
 * agent session methods ask for too (`chat:write`); the agent experience's own scope, which
 * Slack adds to an app declared an agent and which its session status and title need
 * (`assistant:write`); and open its DM with a member, to post the first message of a thread opened
 * there from another of their threads where it isn't known yet (`im:write`). Nothing for
 * channels, files or reading anyone's email address.
 */
export const SLACK_BOT_SCOPES = ['im:history', 'chat:write', 'assistant:write', 'im:write'];

/**
 * The events the app subscribes to: a member's message in its DM, and the app being taken out of
 * the workspace, uninstalled or its token revoked, neither of which needs a scope.
 */
export const SLACK_BOT_EVENTS = ['message.im', 'app_uninstalled', 'tokens_revoked'];

// Slack's limits on the app's name and its short description.
const NAME_MAX = 35;
const DESCRIPTION_MAX = 140;
const AGENT_DESCRIPTION_MAX = 300;

// The first `max` characters of `text`, cut at a space where there is one in the second half, so a
// word isn't cut in two, with nothing trailing. Counted as Slack shows them, by code point.
function cut(text: string, max: number): string {
	const characters = Array.from(text.trim());
	if (characters.length <= max) {
		return characters.join('');
	}
	const kept = characters.slice(0, max).join('');
	const space = kept.lastIndexOf(' ');
	return (space >= max / 2 ? kept.slice(0, space) : kept).trimEnd();
}

/**
 * The app's name in Slack: the persona's, cut to Slack's 35 characters where it is longer, at a
 * word where it can be. Its bot keeps the whole name, which Slack allows 80 characters.
 */
export function slackAppName(personaName: string): string {
	return cut(personaName, NAME_MAX);
}

/** What the manifest is made for: our id for the app, in its events' address, the persona's name, its organization's, and where Personal Agent Proxy is. */
export type ManifestFor = {appId: string; personaName: string; orgName: string; appUrl: string};

/**
 * The manifest: named for the persona, with a bot, the Messages tab on to write to it in, the
 * agent experience on, the bot's scopes, its events sent to `<APP_URL>/slack/events/<id>`, and
 * installing coming back to `<APP_URL>/slack/install`. No socket mode, no interactivity, no token
 * rotation (the bot's token lasts until the app is uninstalled), and installed in one workspace.
 */
export function slackManifest({appId, personaName, orgName, appUrl}: ManifestFor) {
	const name = personaName.trim();
	return {
		display_information: {
			name: slackAppName(name),
			description: cut(`${name}, an agent of ${orgName} on Personal Agent Proxy.`, DESCRIPTION_MAX),
		},
		features: {
			app_home: {home_tab_enabled: false, messages_tab_enabled: true, messages_tab_read_only_enabled: false},
			bot_user: {display_name: name, always_online: true},
			agent_view: {
				agent_description: cut(`${name} from ${orgName}. Write to it here: each message starts a thread it answers you in, as you, with what you use in Personal Agent Proxy.`, AGENT_DESCRIPTION_MAX),
			},
		},
		oauth_config: {
			redirect_urls: [`${appUrl}/slack/install`],
			scopes: {bot: SLACK_BOT_SCOPES},
		},
		settings: {
			event_subscriptions: {request_url: `${appUrl}/slack/events/${appId}`, bot_events: SLACK_BOT_EVENTS},
			org_deploy_enabled: false,
			socket_mode_enabled: false,
			token_rotation_enabled: false,
		},
	};
}
