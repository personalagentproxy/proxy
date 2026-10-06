import {ImapFlow, type ImapFlowOptions} from 'imapflow';
import nodemailer from 'nodemailer';
import {Err, Ok, Result} from 'ts-results-es';

import {ApiErr, type ApiError} from '@proxy/utils';

import {log, serializeError} from '../../observability/log';
import type {EmailCredential} from './credential';

const TIMEOUT_MS = 10_000;

// imapflow flags a rejected login on a plain Error rather than throwing its AuthenticationFailure.
function isImapAuthFailure(error: unknown): boolean {
	return error instanceof Error && 'authenticationFailed' in error && error.authenticationFailed === true;
}

function isSmtpAuthFailure(error: unknown): boolean {
	return error instanceof Error && 'code' in error && error.code === 'EAUTH';
}

/** How Proxy signs in to a mailbox's IMAP server: TLS on 993, giving up after ten seconds. */
export function imapClientOptions(credential: EmailCredential): ImapFlowOptions {
	return {
		host: credential.imapHost,
		port: 993,
		secure: true,
		auth: {user: credential.username, pass: credential.password},
		logger: false,
		connectionTimeout: TIMEOUT_MS,
		greetingTimeout: TIMEOUT_MS,
		socketTimeout: TIMEOUT_MS,
	};
}

/** A failed IMAP sign-in: the password turned down, or the server out of reach. */
export function imapError(error: unknown): ApiError {
	if (isImapAuthFailure(error)) {
		return ApiErr.credentialsRejected();
	}
	return ApiErr.providerUnreachable(error);
}

async function checkImap(credential: EmailCredential): Promise<Result<void, ApiError>> {
	const client = new ImapFlow({...imapClientOptions(credential), verifyOnly: true});
	// A socket error after the check has settled would otherwise crash the process.
	client.on('error', (error: unknown) => log.warn('imap check socket error', serializeError(error)));

	const result = await Result.wrapAsync(() => client.connect());
	client.close();
	return result.mapErr(imapError);
}

async function checkSmtp(credential: EmailCredential): Promise<Result<void, ApiError>> {
	const transport = nodemailer.createTransport({
		host: credential.smtpHost,
		port: credential.smtpPort,
		secure: credential.smtpPort === 465,
		requireTLS: true,
		auth: {user: credential.username, pass: credential.password},
		connectionTimeout: TIMEOUT_MS,
		greetingTimeout: TIMEOUT_MS,
		socketTimeout: TIMEOUT_MS,
	});

	const result = await Result.wrapAsync(() => transport.verify());
	transport.close();
	if (result.isOk()) {
		return Ok(undefined);
	}

	if (isSmtpAuthFailure(result.error)) {
		return Err(ApiErr.credentialsRejected());
	}
	return Err(ApiErr.providerUnreachable(result.error));
}

/** Signs in to the mailbox's IMAP and SMTP servers, so a connection is only saved once both work. */
export async function checkMailbox(credential: EmailCredential): Promise<Result<void, ApiError>> {
	const imap = await checkImap(credential);
	if (imap.isErr()) {
		return imap;
	}
	return checkSmtp(credential);
}
