import sharp from 'sharp';
import {Err, Ok, Result} from 'ts-results-es';
import {z} from 'zod';
import {db} from '@proxy/db';
import {ApiErr, type ApiError, Do, parseSchema, wrapDb} from '@proxy/utils';
import type {AuthenticatedRequest} from '../server/middleware/require-auth';
import {requireOwner} from '../utils/user-org';

const MAX_BYTES = 512 * 1024;
const bodySchema = z.object({
	image: z
		.string()
		.max(Math.ceil((MAX_BYTES * 4) / 3) + 64)
		.nullable(),
});

/** Decode and re-encode pixels: never retain executable formats or embedded metadata. */
export async function normalizeWorkspaceImage(image: string) {
	const match = /^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(image);
	if (!match?.[1]) {
		return Err(ApiErr.validationError('Choose a PNG, JPEG or WebP image.'));
	}
	const bytes = Buffer.from(match[1], 'base64');
	if (bytes.length > MAX_BYTES) {
		return Err(ApiErr.validationError('Choose an image smaller than 512 KB.'));
	}
	const result = await Result.wrapAsync(async () => {
		const input = sharp(bytes, {limitInputPixels: 16_000_000});
		const metadata = await input.metadata();
		if (!metadata.format || !['png', 'jpeg', 'webp'].includes(metadata.format)) {
			return null;
		}
		return input.rotate().resize(256, 256, {fit: 'inside', withoutEnlargement: true}).webp({quality: 85}).toBuffer();
	});
	if (result.isErr() || !result.value) {
		return Err(ApiErr.validationError('This image could not be read. Choose a PNG, JPEG or WebP image.'));
	}
	return Ok(`data:image/webp;base64,${result.value.toString('base64')}`);
}

export function handleOrgImageRoute(request: AuthenticatedRequest): Promise<Result<{ok: boolean}, ApiError>> {
	return Do(async ($) => {
		const {orgId} = $(await requireOwner(request));
		const body = $(parseSchema(bodySchema, request.body));
		const image = body.image === null ? null : $(await normalizeWorkspaceImage(body.image));
		$(await wrapDb(() => db.organization.update({where: {id: orgId}, data: {image}})));
		return {ok: true};
	});
}
