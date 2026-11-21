import {beforeEach, describe, expect, mock, test} from 'bun:test';
import {Err, Ok, type Result} from 'ts-results-es';

import {ApiErr, type ApiError} from '@proxy/utils';
import type {Rotation, SlackWorkspaceRow} from '@proxy/db/slack';

import type {RotatedToken, SlackError} from './slack-api';

mock.module('../observability/log', () => ({
	log: {debug: mock(), info: mock(), warn: mock(), error: mock()},
	serializeError: mock(() => ({})),
}));

mock.module('../utils/secret-crypto', () => ({
	encryptSecret: (plaintext: string): Result<string, ApiError> => Ok(`enc:${plaintext}`),
	decryptSecret: (stored: string): Result<string, ApiError> => Ok(stored.replace(/^enc:/, '')),
}));

const rotateConfigurationToken = mock<(refreshToken: string) => Promise<Result<RotatedToken, SlackError>>>();
mock.module('./slack-api', () => ({rotateConfigurationToken}));

// The workspace's row as the database holds it, which a rotation under the lock reads and writes.
let held: SlackWorkspaceRow;
const rotateSlackWorkspace = mock(async (_id: string, rotate: (row: SlackWorkspaceRow) => Promise<Rotation>) => {
	const rotation = await rotate(held);
	if (rotation.kind === 'rotated') {
		held = {...held, credential: rotation.credential, expiresAt: rotation.expiresAt};
	}
	if (rotation.kind === 'refused') {
		held = {...held, refusedAt: new Date()};
	}
	return Ok({row: held, rotation});
});
const claimDueSlackWorkspaces = mock(async (): Promise<Result<string[], ApiError>> => Ok(['workspace-1']));
const refuseSlackWorkspace = mock(async () => Ok(undefined));
mock.module('@proxy/db/slack', () => ({rotateSlackWorkspace, claimDueSlackWorkspaces, refuseSlackWorkspace}));

const {sweepSlackTokens, withWorkspaceToken} = await import('./workspace-token');

const HOUR = 60 * 60 * 1000;

function workspace(expiresInMs: number, credential = {token: 'xoxe.xoxp-old', refreshToken: 'xoxe-1-old'}): SlackWorkspaceRow {
	return {
		id: 'workspace-1',
		orgId: 'org-1',
		teamId: 'T01',
		name: 'Northwind',
		slackUserId: 'U01',
		credential: `enc:${JSON.stringify(credential)}`,
		expiresAt: new Date(Date.now() + expiresInMs),
		refusedAt: null,
		createdAt: new Date(),
	};
}

const rotated: RotatedToken = {token: 'xoxe.xoxp-new', refreshToken: 'xoxe-1-new', teamId: 'T01', userId: 'U01', expiresAt: new Date(Date.now() + 12 * HOUR)};

// What a call with the token is given, answering with the token it was.
const use = mock(async (token: string): Promise<Result<string, SlackError>> => Ok(token));
const failure = (error: SlackError): ApiError => ApiErr.providerUnreachable(error);

beforeEach(() => {
	mock.clearAllMocks();
	rotateConfigurationToken.mockResolvedValue(Ok(rotated));
	use.mockImplementation(async (token) => Ok(token));
});

describe('a linked workspace’s configuration token', () => {
	test('is used as it is while it has a while to run, asking Slack for nothing', async () => {
		held = workspace(6 * HOUR);

		expect((await withWorkspaceToken(held, use, failure)).unwrap()).toBe('xoxe.xoxp-old');
		expect(rotateSlackWorkspace).not.toHaveBeenCalled();
		expect(rotateConfigurationToken).not.toHaveBeenCalled();
	});

	test('is rotated under the lock before a call where it is about to run out, and the new one is used and kept', async () => {
		held = workspace(2 * 60 * 1000);

		expect((await withWorkspaceToken(held, use, failure)).unwrap()).toBe('xoxe.xoxp-new');
		expect(rotateConfigurationToken).toHaveBeenCalledWith('xoxe-1-old');
		expect(JSON.parse(held.credential.replace(/^enc:/, ''))).toEqual({token: 'xoxe.xoxp-new', refreshToken: 'xoxe-1-new'});
		expect(held.expiresAt).toEqual(rotated.expiresAt);
	});

	test('is not rotated again where another instance rotated it while this one waited for the lock', async () => {
		const stale = workspace(60 * 1000);
		held = workspace(12 * HOUR, {token: 'xoxe.xoxp-theirs', refreshToken: 'xoxe-1-theirs'});

		expect((await withWorkspaceToken(stale, use, failure)).unwrap()).toBe('xoxe.xoxp-theirs');
		expect(rotateConfigurationToken).not.toHaveBeenCalled();
	});

	test('marks the workspace as needing a token where Slack turns the refresh token down, and says so', async () => {
		held = workspace(60 * 1000);
		rotateConfigurationToken.mockResolvedValue(Err({kind: 'refused', method: 'tooling.tokens.rotate', error: 'invalid_refresh_token', problems: []}));

		expect((await withWorkspaceToken(held, use, failure)).unwrapErr()).toEqual(
			ApiErr.conflict('Slack no longer takes the token Northwind was linked with. Paste a new one under Link a Slack workspace.'),
		);
		expect(held.refusedAt).not.toBeNull();
		expect(use).not.toHaveBeenCalled();
	});

	test('keeps the workspace as it is where Slack can’t be reached, for the next try', async () => {
		held = workspace(60 * 1000);
		rotateConfigurationToken.mockResolvedValue(Err({kind: 'rate_limited', method: 'tooling.tokens.rotate', retryAfterSeconds: null}));

		expect((await withWorkspaceToken(held, use, failure)).unwrapErr()).toMatchObject({kind: 'provider_unreachable'});
		expect(held.refusedAt).toBeNull();
	});

	test('marks the workspace as needing a token where a call with it is turned down all the same', async () => {
		held = workspace(6 * HOUR);
		use.mockResolvedValue(Err({kind: 'refused', method: 'apps.manifest.create', error: 'token_revoked', problems: []}));

		expect((await withWorkspaceToken(held, use, failure)).isErr()).toBe(true);
		expect(refuseSlackWorkspace).toHaveBeenCalledWith('workspace-1');
	});

	test('is refused at once where it is marked as needing a token', async () => {
		held = {...workspace(6 * HOUR), refusedAt: new Date()};

		expect((await withWorkspaceToken(held, use, failure)).unwrapErr()).toMatchObject({kind: 'conflict'});
		expect(use).not.toHaveBeenCalled();
	});
});

describe('the sweep', () => {
	test('takes the workspaces due, with a lease, and rotates each running out within two hours', async () => {
		held = workspace(90 * 60 * 1000);

		await sweepSlackTokens();

		expect(claimDueSlackWorkspaces).toHaveBeenCalledWith(5 * 60 * 1000, 20);
		expect(rotateSlackWorkspace).toHaveBeenCalledTimes(1);
		expect(rotateConfigurationToken).toHaveBeenCalledWith('xoxe-1-old');
	});

	test('leaves one with longer to run as it is, as where another instance rotated it first', async () => {
		held = workspace(11 * HOUR);

		await sweepSlackTokens();

		expect(rotateConfigurationToken).not.toHaveBeenCalled();
	});

	test('marks one Slack turns down, and takes nothing where the claim fails', async () => {
		held = workspace(60 * 1000);
		rotateConfigurationToken.mockResolvedValue(Err({kind: 'refused', method: 'tooling.tokens.rotate', error: 'invalid_refresh_token', problems: []}));
		await sweepSlackTokens();
		expect(held.refusedAt).not.toBeNull();

		rotateSlackWorkspace.mockClear();
		claimDueSlackWorkspaces.mockResolvedValueOnce(Err(ApiErr.dbError(new Error('down'))));
		await sweepSlackTokens();
		expect(rotateSlackWorkspace).not.toHaveBeenCalled();
	});
});
