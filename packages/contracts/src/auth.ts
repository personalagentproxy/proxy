import {z} from 'zod';

/** A person's sign-in (`/auth/…`). */

/**
 * `POST /auth/email`'s answer: `{ok: true}`, with `logged` when the api wrote the link to its log
 * for lack of a way to send email, or, with a 4xx/5xx, `{error}` with a code the login page maps
 * to copy.
 */
export const magicLinkResponseSchema = z.object({
	ok: z.boolean().optional(),
	logged: z.boolean().optional(),
	error: z.string().optional(),
});

export type MagicLinkResponse = z.infer<typeof magicLinkResponseSchema>;

/**
 * `GET /auth/methods`: the sign-in methods beside the magic link, which always is, so the login
 * page offers only those set up, and what the server has of what integrations need (`needs`), so
 * the catalog offers only the ones whose sign-in can start: a Google connection needs the client,
 * and a bank connected through Plaid the server's Plaid keys.
 */
export const signInMethodsSchema = z.object({
	google: z.boolean(),
	needs: z.object({google: z.boolean(), plaid: z.boolean()}),
});

export type SignInMethods = z.infer<typeof signInMethodsSchema>;
