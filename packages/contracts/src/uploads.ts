import {z} from 'zod';

/**
 * Where the bytes of an upload into a drive kept in Personal Agent Proxy go (api uploads/), for
 * whatever sends them: a model's `curl`, a sandbox's `pap files push`. A call starts the upload
 * and is answered with the URL, `PUT {UPLOADS_PATH}/<secret>`; the secret in it is the only
 * credential, so it needs no session, no token and no particular origin. The body is the file, as
 * bytes, whatever its `Content-Type`; no more than the upload said it would be is taken. One PUT is
 * taken for an upload, and none after its hour; one that fails partway can be sent again.
 * `files_upload_done` with the upload's id then makes the file.
 * - 200: `uploadReceivedSchema`, what arrived.
 * - 4xx: `uploadRefusedSchema`, `{error, message}`: unknown or no longer taking bytes (404), past
 *   its hour (410), taken already (409), more than was said (413).
 */
export const UPLOADS_PATH = '/api/uploads';

export const uploadReceivedSchema = z.object({
	/** The upload's id, which files_upload_done takes. */
	upload: z.string(),
	/** What arrived: how many bytes, and their SHA-256 in hex. */
	size: z.number(),
	sha256: z.string(),
	/** What to do next, for a model. */
	next: z.string(),
});

export type UploadReceived = z.infer<typeof uploadReceivedSchema>;

export const uploadRefusedSchema = z.object({error: z.string(), message: z.string()});

export type UploadRefused = z.infer<typeof uploadRefusedSchema>;
