import {z} from 'zod';

/**
 * A blob is a file on its way through Personal Agent Proxy (api blobs/): bytes kept for a day,
 * made by one agent and usable only by it. A tool makes one of a file somewhere, as
 * `attachments_blob` of an email's attachment or `files_blob` of a drive's file, and a tool takes
 * one, as `files_upload` puts it in a drive and an email attaches it. Bytes move between a blob and whatever an agent runs
 * on, a model's shell or a sandbox, through URLs of Personal Agent Proxy's own, which
 * `pap.upload()` and `pap.download(blob)` answer with. The URL is the only credential, signed and
 * good for an hour, so it needs no session, no token and no particular origin.
 *
 * - `PUT {BLOBS_PATH}/<token>[?name=<file name>]`, from `pap.upload()`: the body, the file as
 *   bytes whatever its `Content-Type`, becomes a new blob of the agent's, called what `name`
 *   says, where it says. Each PUT makes a blob of its own, so a URL takes as many files as are
 *   sent to it in its hour. 200: `blobStoredSchema`. 4xx: `blobRefusedSchema`.
 * - `GET {BLOBS_PATH}/<token>`, from `pap.download(blob)`: the blob's bytes.
 */
export const BLOBS_PATH = '/api/blobs';

export const blobStoredSchema = z.object({
	/** The blob's id, which a tool that takes a file takes as `blob`. */
	blob: z.string(),
	name: z.string().nullable(),
	/** What arrived: how many bytes, and their SHA-256 in hex. */
	size: z.number(),
	sha256: z.string(),
});

export type BlobStored = z.infer<typeof blobStoredSchema>;

export const blobRefusedSchema = z.object({error: z.string(), message: z.string()});

export type BlobRefused = z.infer<typeof blobRefusedSchema>;

/** What `pap.upload()` answers: where to PUT a file to make a blob of it, and until when. */
export const blobUploadSchema = z.object({
	url: z.string(),
	method: z.literal('PUT'),
	expiresAt: z.string(),
});

export type BlobUpload = z.infer<typeof blobUploadSchema>;

/** What `pap.download(blob)` answers: which file it is, and where to GET its bytes until when. */
export const blobDownloadSchema = z.object({
	blob: z.string(),
	name: z.string().nullable(),
	type: z.string().nullable(),
	size: z.number(),
	url: z.string(),
	expiresAt: z.string(),
});

export type BlobDownload = z.infer<typeof blobDownloadSchema>;
