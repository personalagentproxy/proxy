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
