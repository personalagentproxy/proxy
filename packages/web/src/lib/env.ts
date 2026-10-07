import {z} from 'zod';

const envSchema = z.object({
	// Unset when the api serves the web app itself (the Docker image): calls go to the page's own
	// origin.
	VITE_PROXY_API_URL: z.url().optional(),
});

const parsed = envSchema.parse({
	VITE_PROXY_API_URL: import.meta.env.VITE_PROXY_API_URL,
});

/** Validated client env, from the root `.env` through Vite's `import.meta.env`. */
export const env = {
	apiUrl: (parsed.VITE_PROXY_API_URL ?? '').replace(/\/$/, ''),
	isDev: import.meta.env.DEV,
} as const;
