import {z} from 'zod';

/** What a TickTick connection stores, encrypted: the personal API token it signs in with. */
export const ticktickCredentialSchema = z.object({token: z.string().min(1)});

export type TickTickCredential = z.infer<typeof ticktickCredentialSchema>;
