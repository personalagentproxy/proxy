import {config} from 'dotenv';
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

import {envSchema} from './env-schema';

const packageDir = dirname(fileURLToPath(import.meta.url));

config({path: resolve(packageDir, '../../../../.env')});

// An empty variable counts as unset, as Docker Compose passes an optional one it has no value for.
function read(name: string): string | undefined {
	return process.env[name] || undefined;
}

export const env = envSchema.parse({
	DATABASE_URL: read('DATABASE_URL'),
	APP_URL: read('APP_URL'),
	AUTH_SECRET: read('AUTH_SECRET'),
	ENCRYPTION_KEY: read('ENCRYPTION_KEY'),
	GOOGLE_CLIENT_ID: read('GOOGLE_CLIENT_ID'),
	GOOGLE_CLIENT_SECRET: read('GOOGLE_CLIENT_SECRET'),
	RESEND_KEY: read('RESEND_KEY'),
	EMAIL_FROM: read('EMAIL_FROM'),
	OPENROUTER_KEY: read('OPENROUTER_KEY'),
	ALLOWED_SIGNUP_EMAILS: read('ALLOWED_SIGNUP_EMAILS'),
	PLAID_CLIENT_ID: read('PLAID_CLIENT_ID'),
	PLAID_SECRET: read('PLAID_SECRET'),
	PLAID_ENV: read('PLAID_ENV'),
	NODE_ENV: read('NODE_ENV'),
	PORT: read('PORT'),
	TELEMETRY_ENABLED: read('TELEMETRY_ENABLED'),
	APP_VERSION: read('APP_VERSION'),
	ALLOW_PRIVATE_HOSTS: read('ALLOW_PRIVATE_HOSTS'),
});
