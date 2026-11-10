import {describe, expect, test} from 'bun:test';

import {fakeHarness} from '@proxy/backends/harness/fake';

import {authFor, harnessFor, needsCredential, NOT_SET_UP, ownAccountTurnCap} from './harness';

const proxy = fakeHarness('proxy');
const sdk = fakeHarness('claude-agent-sdk');
const both = {proxy, claudeAgentSdk: sdk};
const proxyOnly = {proxy, claudeAgentSdk: null};
const token = {kind: 'setup_token' as const, token: 'tok'};
const asAuth = {kind: 'oauth' as const, accessToken: 'tok', scopes: []};

describe('which harness runs a thread', () => {
	test('a member’s turn goes to the SDK harness where they have a Claude credential and the server has it, else to the proxy harness, else nowhere', () => {
		expect(harnessFor(both, token)).toEqual({harness: sdk, auth: asAuth});
		expect(harnessFor(both, null)).toEqual({harness: proxy, auth: null});
		expect(harnessFor(proxyOnly, token)).toEqual({harness: proxy, auth: null});
		expect(harnessFor({proxy: null, claudeAgentSdk: sdk}, token)).toEqual({harness: sdk, auth: asAuth});
		expect(harnessFor({proxy: null, claudeAgentSdk: null}, null)).toEqual({harness: null, auth: null, why: NOT_SET_UP});
		expect(harnessFor({proxy: null, claudeAgentSdk: sdk}, null)).toEqual({harness: null, auth: null, why: NOT_SET_UP});
	});

	test('the credential is looked for only where the choice turns on it: the SDK harness is here', () => {
		expect(needsCredential(both)).toBe(true);
		expect(needsCredential(proxyOnly)).toBe(false);
	});

	test('the turns on members’ own accounts are capped as the SDK harness is, and not at all without it or without a cap of its', () => {
		expect(ownAccountTurnCap({proxy, claudeAgentSdk: {...sdk, maxConcurrentTurns: 2}})).toBe(2);
		expect(ownAccountTurnCap(both)).toBeNull();
		expect(ownAccountTurnCap(proxyOnly)).toBeNull();
	});

	test('a token is handed over as a sign-in’s access token with no scopes, and an API key as itself', () => {
		expect(authFor({kind: 'setup_token', token: 'sk-ant-oat01-x'})).toEqual({kind: 'oauth', accessToken: 'sk-ant-oat01-x', scopes: []});
		expect(authFor({kind: 'api_key', key: 'sk-ant-api-x'})).toEqual({kind: 'api_key', key: 'sk-ant-api-x'});
	});
});
