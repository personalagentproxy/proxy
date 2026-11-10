import {Err, Ok, type Result} from 'ts-results-es';

import {ApiErr, type ApiError} from '@proxy/utils';
import type {ClaudeAccountKind} from '@proxy/contracts/me';

/**
 * What the api knows of a Claude credential handed to it: which kind a pasted token is, by its
 * prefix, and the words for a credential that is no good any more. The api mints nothing itself:
 * a token comes from `claude setup-token`, or from the desktop app doing the same
 * (@proxy/utils/claude-oauth), and is stored as it is.
 */

const SETUP_TOKEN_PREFIX = 'sk-ant-oat01-';
const API_KEY_PREFIX = 'sk-ant-api';

export const UNKNOWN_TOKEN = 'Paste a token from `claude setup-token` or an Anthropic API key.';
export const SIGN_IN_EXPIRED = 'Your Claude sign-in has run out or was refused. Connect it again on the Account page.';

/** Which kind a pasted token is, by its prefix: `claude setup-token`'s, or an Anthropic API key's. */
export function classifyPastedToken(token: string): Result<ClaudeAccountKind, ApiError> {
	if (token.startsWith(SETUP_TOKEN_PREFIX)) {
		return Ok('setup_token');
	}
	if (token.startsWith(API_KEY_PREFIX)) {
		return Ok('api_key');
	}
	return Err(ApiErr.validationError(UNKNOWN_TOKEN));
}
