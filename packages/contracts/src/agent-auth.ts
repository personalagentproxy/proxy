import {z} from 'zod';

/** An agent's own sign-in (`/agent-auth/…`), for the web app's agent pages. */

/** `POST /agent-auth/login`: 401 for a wrong username or password, 403 for a revoked login. */
export const agentLoginBodySchema = z.object({
	username: z.string().trim().min(1),
	password: z.string().min(1),
});

/** The agent signed in. */
export const agentLoginSchema = z.object({agentId: z.string()});
