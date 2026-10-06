import {config} from 'dotenv';
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {z} from 'zod';

const packageDir = dirname(fileURLToPath(import.meta.url));

config({path: resolve(packageDir, '../../../../.env')});

// Trailing slashes are stripped so callers can build `${url}/path` without producing `//path`.
const originSchema = z
	.string()
	.url()
	.transform((value) => value.replace(/\/+$/, ''));

const envSchema = z.object({
	DATABASE_URL: z.url(),
	NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
	PORT: z.string().regex(/^\d+$/, 'PORT must be a positive integer').optional(),

	// The web app's origin: the one origin CORS allows, and where the sign-in flows land.
	APP_URL: originSchema.optional(),

	// This api's public origin, which the OAuth redirect_uri and the magic link point at. Falls
	// back to VITE_PROXY_API_URL from the shared root .env, which names the same origin.
	PROXY_API_PUBLIC_URL: originSchema.optional(),

	// Google sign-in. Optional so the api boots without it; the /auth/google routes then
	// error-redirect to the login page.
	GOOGLE_CLIENT_ID: z.string().min(1).optional(),
	GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),

	// Hashes magic-link tokens before they are stored. Optional so the api boots without email
	// sign-in; the /auth/email routes then fail gracefully.
	AUTH_SECRET: z.string().min(1).optional(),

	// Sends the magic-link emails. Dev logs the link instead, so neither is needed there.
	RESEND_KEY: z.string().min(1).optional(),
	EMAIL_FROM: z.string().min(1).optional(),

	// Cookie Domain for the session cookie. Unset in dev, where app and api are both on localhost
	// and a host-only cookie reaches both. Set to the shared parent domain (e.g. `.example.com`)
	// when they are sibling subdomains.
	SESSION_COOKIE_DOMAIN: z.string().optional(),
});

const envData = {
	DATABASE_URL: process.env.DATABASE_URL,
	NODE_ENV: process.env.NODE_ENV,
	PORT: process.env.PORT,
	APP_URL: process.env.APP_URL,
	PROXY_API_PUBLIC_URL: process.env.PROXY_API_PUBLIC_URL ?? process.env.VITE_PROXY_API_URL,
	GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
	GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
	AUTH_SECRET: process.env.AUTH_SECRET,
	RESEND_KEY: process.env.RESEND_KEY,
	EMAIL_FROM: process.env.EMAIL_FROM,
	SESSION_COOKIE_DOMAIN: process.env.SESSION_COOKIE_DOMAIN,
};

export const env = envSchema.parse(envData);
