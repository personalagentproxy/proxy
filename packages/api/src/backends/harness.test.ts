import {describe, expect, test} from 'bun:test';

import {fakeHarness} from '@proxy/backends/harness/fake';

import {authFor, harnessFor, needsCredential, NOT_SET_UP} from './harness';

const proxy = fakeHarness('proxy');
const sdk = fakeHarness('claude-agent-sdk');
const both = {proxy, claudeAgentSdk: sdk};
const proxyOnly = {proxy, claudeAgentSdk: null};
const oauth = {kind: 'oauth' as const, accessToken: 'tok', scopes: ['user:inference']};

describe('which harness runs a thread', () => {
	test('a new thread goes to the SDK harness where the member has a Claude credential and the server has it, else to the proxy harness, else nowhere', () => {
		expect(harnessFor(both, {harness: null}, oauth)).toEqual({harness: sdk, auth: {kind: 'oauth', accessToken: 'tok', scopes: ['user:inference']}});
		expect(harnessFor(both, {harness: null}, null)).toEqual({harness: proxy, auth: null});
		expect(harnessFor(proxyOnly, {harness: null}, oauth)).toEqual({harness: proxy, auth: null});
		expect(harnessFor({proxy: null, claudeAgentSdk: null}, {harness: null}, null)).toEqual({harness: null, auth: null, why: NOT_SET_UP});
		expect(harnessFor({proxy: null, claudeAgentSdk: sdk}, {harness: null}, null)).toEqual({harness: null, auth: null, why: NOT_SET_UP});
	});

	test('a thread stays with the harness it recorded: the proxy harness whatever the credential, the SDK harness with one, and none where the server hasn’t got it or the credential is gone', () => {
		expect(harnessFor(both, {harness: 'proxy'}, oauth)).toEqual({harness: proxy, auth: null});
		expect(harnessFor(both, {harness: 'claude-agent-sdk'}, oauth)).toEqual({harness: sdk, auth: {kind: 'oauth', accessToken: 'tok', scopes: ['user:inference']}});
		expect(harnessFor(both, {harness: 'claude-agent-sdk'}, null)).toEqual({harness: null, auth: null, why: expect.stringContaining('Connect it again on the Account page')});
		expect(harnessFor(proxyOnly, {harness: 'claude-agent-sdk'}, oauth)).toEqual({
			harness: null,
			auth: null,
			why: 'This conversation runs on the claude-agent-sdk harness, which this server hasn’t got. Everything else works as before.',
		});
		expect(harnessFor({proxy: null, claudeAgentSdk: sdk}, {harness: 'proxy'}, null)).toEqual({harness: null, auth: null, why: expect.stringContaining('proxy harness')});
	});

	test('the credential is looked for only where the choice turns on it: the SDK harness is here, and the thread isn’t the proxy harness’s already', () => {
		expect(needsCredential(both, {harness: null})).toBe(true);
		expect(needsCredential(both, {harness: 'claude-agent-sdk'})).toBe(true);
		expect(needsCredential(both, {harness: 'proxy'})).toBe(false);
		expect(needsCredential(proxyOnly, {harness: null})).toBe(false);
	});

	test('a setup token is handed over as a sign-in’s token with no scopes, and an API key as itself', () => {
		expect(authFor({kind: 'setup_token', token: 'sk-ant-oat01-x'})).toEqual({kind: 'oauth', accessToken: 'sk-ant-oat01-x', scopes: []});
		expect(authFor({kind: 'api_key', key: 'sk-ant-api-x'})).toEqual({kind: 'api_key', key: 'sk-ant-api-x'});
		expect(authFor(oauth)).toEqual({kind: 'oauth', accessToken: 'tok', scopes: ['user:inference']});
	});
});
