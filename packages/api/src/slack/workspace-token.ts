import {Err, type Result} from 'ts-results-es';
import {z} from 'zod';

import {ApiErr, type ApiError, Do} from '@proxy/utils';
import {claimDueSlackWorkspaces, refuseSlackWorkspace, type Rotation, rotateSlackWorkspace, type SlackWorkspaceRow} from '@proxy/db/slack';

import {log, serializeError} from '../observability/log';
import {encryptSecret} from '../utils/secret-crypto';
import {readStoredJson} from '../utils/stored-json';
import {rotateConfigurationToken, type RotatedToken, type SlackError} from './slack-api';
import {isTokenGone} from './slack-errors';

/**
 * A linked workspace's app configuration token, kept fresh. Slack's lasts twelve hours, and its
 * refresh token works once, for the next pair: the sweep, in each api instance, rotates every
 * workspace's a couple of hours before it runs out, and a call about to be made with one that runs
 * out within minutes rotates it first. Either way it is rotated under a lock on the workspace's
 * row, looked at again once the lock is held (`rotateSlackWorkspace`), so two instances never
 * spend the same refresh token: the second finds the first's fresh one. Where Slack turns the
 * refresh token down for good, the workspace is marked so, and the page asks for a token again.
 */

/** What a workspace's credential holds, encrypted. */
export const workspaceCredentialSchema = z.object({token: z.string(), refreshToken: z.string()});

// A call is made with a token good for at least this long; one closer to its end is rotated first.
const ON_DEMAND_MARGIN_MS = 10 * 60 * 1000;
// The sweep rotates a token this long before it runs out, so a few sweeps failing in a row, as
// with Slack away for a while, still leave it time.
const SWEEP_MARGIN_MS = 2 * 60 * 60 * 1000;
// How often the sweep looks, how long a workspace it took is left to it, and how many it takes.
const SWEEP_MS = 5 * 60 * 1000;
const LEASE_MS = 5 * 60 * 1000;
const SWEEP_LIMIT = 20;

/** When the sweep is to rotate a token that runs out at `expiresAt`. */
export function rotateAtFor(expiresAt: Date): Date {
	return new Date(expiresAt.getTime() - SWEEP_MARGIN_MS);
}

/** A rotated pair as it is kept: encrypted, with when it runs out and when the sweep takes it next. */
export function keptRotation(rotated: RotatedToken): Result<{credential: string; expiresAt: Date; rotateAt: Date}, ApiError> {
	return encryptSecret(JSON.stringify({token: rotated.token, refreshToken: rotated.refreshToken})).map((credential) => ({
		credential,
		expiresAt: rotated.expiresAt,
		rotateAt: rotateAtFor(rotated.expiresAt),
	}));
}

/** What the member is told where the workspace's token has to be pasted again. */
export function needsTokenMessage(workspace: {name: string}): string {
	return `Slack no longer takes the token ${workspace.name} was linked with. Paste a new one under Link a Slack workspace.`;
}

// Why a rotation didn't happen, for the logs and the caller.
function rotationFailure(error: SlackError): ApiError {
	return ApiErr.providerUnreachable(error, 'Slack can’t be reached right now. Try again in a moment.');
}

// Under the lock: the token as it is, where it is good for `marginMs` more; otherwise rotated.
function decide(marginMs: number): (row: SlackWorkspaceRow) => Promise<Rotation> {
	return async (row) => {
		if (row.refusedAt !== null) {
			return {kind: 'failed', error: ApiErr.conflict(needsTokenMessage(row))};
		}
		if (row.expiresAt.getTime() - marginMs > Date.now()) {
			return {kind: 'fresh'};
		}
		const credential = readStoredJson(row.credential, workspaceCredentialSchema);
		if (credential.isErr()) {
			return {kind: 'failed', error: credential.error};
		}
		const rotated = await rotateConfigurationToken(credential.value.refreshToken);
		if (rotated.isErr()) {
			return isTokenGone(rotated.error) ? {kind: 'refused'} : {kind: 'failed', error: rotationFailure(rotated.error)};
		}
		const kept = keptRotation(rotated.value);
		if (kept.isErr()) {
			return {kind: 'failed', error: kept.error};
		}
		return {kind: 'rotated', ...kept.value};
	};
}

// The workspace's token, rotated first where it runs out within `marginMs`.
function freshToken(workspace: SlackWorkspaceRow, marginMs: number): Promise<Result<string, ApiError>> {
	return Do(async ($) => {
		if (workspace.refusedAt !== null) {
			return $(Err(ApiErr.conflict(needsTokenMessage(workspace))));
		}
		let row = workspace;
		if (row.expiresAt.getTime() - marginMs <= Date.now()) {
			const looked = $(await rotateSlackWorkspace(workspace.id, decide(marginMs)));
			if (looked === null) {
				return $(Err(ApiErr.notFound('Slack workspace', workspace.id)));
			}
			if (looked.rotation.kind === 'failed') {
				return $(Err(looked.rotation.error));
			}
			if (looked.rotation.kind === 'refused') {
				return $(Err(ApiErr.conflict(needsTokenMessage(workspace))));
			}
			row = looked.row;
		}
		return $(readStoredJson(row.credential, workspaceCredentialSchema)).token;
	});
}

/**
 * Calls Slack with the workspace's configuration token, rotated first where it is about to run
 * out. Where Slack turns the token down all the same, as for one revoked in Slack, the workspace is
 * marked as needing it again. What `use` answers, its Slack errors as `failure` turns them.
 */
export function withWorkspaceToken<T>(workspace: SlackWorkspaceRow, use: (token: string) => Promise<Result<T, SlackError>>, failure: (error: SlackError) => ApiError): Promise<Result<T, ApiError>> {
	return Do(async ($) => {
		const token = $(await freshToken(workspace, ON_DEMAND_MARGIN_MS));
		const used = await use(token);
		if (used.isOk()) {
			return used.value;
		}
		if (isTokenGone(used.error)) {
			$(await refuseSlackWorkspace(workspace.id));
		}
		return $(Err(failure(used.error)));
	});
}

/** One sweep: the workspaces due, each rotated where it runs out within the sweep's margin; one that fails is logged and comes again. */
export async function sweepSlackTokens(): Promise<void> {
	const due = await claimDueSlackWorkspaces(LEASE_MS, SWEEP_LIMIT);
	if (due.isErr()) {
		log.error('The Slack token sweep could not take the workspaces due', serializeError(due.error));
		return;
	}
	for (const workspaceId of due.value) {
		const looked = await rotateSlackWorkspace(workspaceId, decide(SWEEP_MARGIN_MS));
		if (looked.isErr()) {
			log.warn('A Slack workspace’s token could not be rotated', {workspaceId, ...serializeError(looked.error)});
			continue;
		}
		const rotation = looked.value?.rotation;
		if (rotation?.kind === 'failed') {
			log.warn('A Slack workspace’s token could not be rotated', {workspaceId, kind: rotation.error.kind, ...('cause' in rotation.error ? serializeError(rotation.error.cause) : {})});
		}
		if (rotation?.kind === 'refused') {
			log.info('Slack turned a workspace’s refresh token down; it needs a token again', {workspaceId});
		}
	}
}

export type SlackTokenSweeper = {stop: () => void};

/** Starts the sweep; it runs until stopped. */
export function startSlackTokenSweeper(): SlackTokenSweeper {
	let running = false;
	const tick = async (): Promise<void> => {
		if (running) {
			return;
		}
		running = true;
		await sweepSlackTokens().catch((error: unknown) => log.error('The Slack token sweep failed', serializeError(error)));
		running = false;
	};
	const timer = setInterval(() => void tick(), SWEEP_MS);
	void tick();
	return {
		stop: () => {
			clearInterval(timer);
		},
	};
}
