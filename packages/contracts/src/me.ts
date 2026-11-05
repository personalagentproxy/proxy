import {z} from 'zod';

/** `GET /api/me`: who is signed in. The organizations they are in are `GET /api/orgs` (`orgs.ts`). */
export const meSchema = z.object({
	user: z.object({
		id: z.string(),
		email: z.string(),
		name: z.string().nullable(),
		image: z.string().nullable(),
	}),
});

export type Me = z.infer<typeof meSchema>;

/**
 * One of the person's sessions in `GET /api/me/sessions`: where it signed in, read from its
 * User-Agent (`client` a browser's name or `Desktop app`, `os` the system, each null when the
 * header said nothing we know, or the session is older than keeping it), when, and whether it is
 * the one asking.
 */
export const sessionSchema = z.object({
	id: z.string(),
	client: z.string().nullable(),
	os: z.string().nullable(),
	createdAt: z.string(),
	current: z.boolean(),
});

export type Session = z.infer<typeof sessionSchema>;

export const sessionsSchema = z.object({sessions: z.array(sessionSchema)});

export type Sessions = z.infer<typeof sessionsSchema>;
