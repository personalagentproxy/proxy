import type {Result} from 'ts-results-es';
import {z} from 'zod';

import type {ApiError} from '@proxy/utils';

import {decryptSecret} from '../utils/secret-crypto';
import {readStoredJson} from '../utils/stored-json';

/** What a persona's Slack app keeps of the secrets Slack made it with, encrypted: its client's, for installing it, and the one Slack signs its requests with. */
export const appSecretsSchema = z.object({clientSecret: z.string(), signingSecret: z.string()});

export type AppSecrets = z.infer<typeof appSecretsSchema>;

export function readAppSecrets(stored: string): Result<AppSecrets, ApiError> {
	return readStoredJson(stored, appSecretsSchema);
}

/** The app's bot token, kept encrypted on its own. */
export function readBotToken(stored: string): Result<string, ApiError> {
	return decryptSecret(stored);
}
