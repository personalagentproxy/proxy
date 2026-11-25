import {describe, expect, test} from 'bun:test';

import {SLACK_BOT_SCOPES, SLACK_MANIFEST_VERSION, slackAppName, slackManifest} from './manifest';

const made = {appId: 'app-1', personaName: 'Finance', orgName: 'Northwind', appUrl: 'https://proxy.example.com'};

describe('the Slack app manifest', () => {
	test('names the app and its bot for the persona, with the Messages tab and the agent experience on', () => {
		const manifest = slackManifest(made);

		expect(manifest.display_information.name).toBe('Finance');
		expect(manifest.features.bot_user).toEqual({display_name: 'Finance', always_online: true});
		expect(manifest.features.app_home).toEqual({home_tab_enabled: false, messages_tab_enabled: true, messages_tab_read_only_enabled: false});
		expect(manifest.features.agent_view.agent_description).toContain('Finance');
	});

	test('sends its events to the app’s own address and its install back to ours, over https', () => {
		const manifest = slackManifest(made);

		expect(manifest.settings.event_subscriptions).toEqual({request_url: 'https://proxy.example.com/slack/events/app-1', bot_events: ['message.im', 'app_uninstalled', 'tokens_revoked']});
		expect(manifest.oauth_config.redirect_urls).toEqual(['https://proxy.example.com/slack/install']);
		expect(manifest.settings).toMatchObject({socket_mode_enabled: false, org_deploy_enabled: false, token_rotation_enabled: false});
	});

	test('asks for a DM’s messages, posting, the agent experience and opening its DM, and nothing for channels, files or email addresses', () => {
		expect(slackManifest(made).oauth_config.scopes.bot).toEqual(['im:history', 'chat:write', 'assistant:write', 'im:write']);
		expect(SLACK_BOT_SCOPES.some((scope) => /^(channels|groups|mpim|files|users:read\.email)/.test(scope))).toBe(false);
	});

	test('keeps within Slack’s limits: a name past 35 characters cut at a word, the bot’s whole, and the descriptions short enough', () => {
		const long = 'Quarterly planning and budget reviews for everyone';
		const manifest = slackManifest({...made, personaName: long, orgName: 'A'.repeat(200)});

		expect(slackAppName(long)).toBe('Quarterly planning and budget');
		expect(Array.from(manifest.display_information.name).length).toBeLessThanOrEqual(35);
		expect(manifest.features.bot_user.display_name).toBe(long);
		expect(Array.from(manifest.display_information.description).length).toBeLessThanOrEqual(140);
		expect(Array.from(manifest.features.agent_view.agent_description).length).toBeLessThanOrEqual(300);
		expect(slackAppName('A'.repeat(50))).toBe('A'.repeat(35));
		expect(slackAppName('  Finance  ')).toBe('Finance');
	});

	test('has a version, which apps made from an older one are offered an update to', () => {
		expect(Number.isInteger(SLACK_MANIFEST_VERSION)).toBe(true);
		expect(SLACK_MANIFEST_VERSION).toBeGreaterThanOrEqual(1);
	});
});
