import {describe, expect, test} from 'bun:test';

import {fakeHarness} from '@proxy/backends/harness/fake';

import {authFor, cappedHarness, chosenFor, CONNECT_CLAUDE, harnessesOf, harnessFor, needsCredential, NOT_SET_UP} from './harness';

const proxy = fakeHarness('proxy');
const sdk = fakeHarness('claude-agent-sdk');
const both = {proxy, claudeAgentSdk: sdk};
const proxyOnly = {proxy, claudeAgentSdk: null};
const token = {kind: 'setup_token' as const, token: 'tok'};
const asAuth = {kind: 'oauth' as const, accessToken: 'tok', scopes: []};

describe('which harness runs a thread', () => {
	test('a persona runs on the harness it chose with the model it chose of that harness’s, the harness’s first where it has none of that name', () => {
		expect(chosenFor(both, {harness: 'proxy', chatModel: 'other'})).toEqual({harness: proxy, model: 'other'});
		expect(chosenFor(both, {harness: 'claude-agent-sdk', chatModel: 'claude'})).toEqual({harness: sdk, model: 'claude'});
		expect(chosenFor(both, {harness: 'proxy', chatModel: 'dropped-long-ago'})).toEqual({harness: proxy, model: 'claude'});
	});

	test('a harness the server hasn’t got is read as the first it has, and a server with none has nothing to run on', () => {
		expect(chosenFor(proxyOnly, {harness: 'claude-agent-sdk', chatModel: 'other'})).toEqual({harness: proxy, model: 'other'});
		expect(chosenFor({proxy: null, claudeAgentSdk: sdk}, {harness: 'proxy', chatModel: 'claude'})).toEqual({harness: sdk, model: 'claude'});
		expect(chosenFor({proxy: null, claudeAgentSdk: null}, {harness: 'proxy', chatModel: 'claude'})).toBeNull();
		expect(harnessesOf(both)).toEqual([proxy, sdk]);
	});

	test('a turn on the proxy harness takes no credential, whatever the member connected; one on the SDK harness takes the member’s, and a member without one is told to connect it', () => {
		expect(harnessFor(both, {harness: 'proxy', chatModel: 'other'}, token)).toEqual({harness: proxy, model: 'other', auth: null});
		expect(harnessFor(both, {harness: 'claude-agent-sdk', chatModel: 'other'}, token)).toEqual({harness: sdk, model: 'other', auth: asAuth});
		expect(harnessFor(both, {harness: 'claude-agent-sdk', chatModel: 'other'}, null)).toEqual({harness: null, auth: null, why: CONNECT_CLAUDE});
		expect(harnessFor(proxyOnly, {harness: 'claude-agent-sdk', chatModel: 'claude'}, null)).toEqual({harness: proxy, model: 'claude', auth: null});
		expect(harnessFor({proxy: null, claudeAgentSdk: null}, {harness: 'proxy', chatModel: 'claude'}, null)).toEqual({harness: null, auth: null, why: NOT_SET_UP});
	});

	test('the credential is looked for only where the harness runs on it: the SDK harness', () => {
		expect(needsCredential(both, sdk)).toBe(true);
		expect(needsCredential(both, proxy)).toBe(false);
	});

	test('the turns on the SDK harness are capped as it says, and not at all without it or without a cap of its', () => {
		expect(cappedHarness({proxy, claudeAgentSdk: {...sdk, maxConcurrentTurns: 2}})).toEqual({harness: 'claude-agent-sdk', turns: 2});
		expect(cappedHarness(both)).toBeNull();
		expect(cappedHarness(proxyOnly)).toBeNull();
	});

	test('a token is handed over as a sign-in’s access token with no scopes, and an API key as itself', () => {
		expect(authFor({kind: 'setup_token', token: 'sk-ant-oat01-x'})).toEqual({kind: 'oauth', accessToken: 'sk-ant-oat01-x', scopes: []});
		expect(authFor({kind: 'api_key', key: 'sk-ant-api-x'})).toEqual({kind: 'api_key', key: 'sk-ant-api-x'});
	});
});
