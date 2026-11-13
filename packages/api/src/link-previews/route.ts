import type {Request, Response} from 'express';

import {ApiErr} from '@proxy/utils';

import {get} from '../favicons/favicon';
import {sendApiError} from '../server/response';
import {signedIn} from '../favicons/route';
import {previewOf, previewable} from './preview';

const KEEP_SECONDS = 60 * 60;
const IMAGE_MAX_BYTES = 2_000_000;
const SAFE_IMAGES = /^image\/(png|jpe?g|gif|webp|avif)$/i;

function queryUrl(req: Request) {
	const address = req.query.url;
	return previewable(typeof address === 'string' ? address : undefined);
}

/**
 * `GET /api/link-previews?url=`: what a link's card shows of its page (title, description, site,
 * the address of its picture), to a signed-in person or agent. The page is fetched by this server,
 * never by the browser, so the page learns nothing of whoever hovered the link.
 */
export async function handleLinkPreviewRoute(req: Request, res: Response): Promise<void> {
	const signed = await signedIn(req.headers);
	if (signed.isErr()) {
		sendApiError(res, signed.error);
		return;
	}
	const url = queryUrl(req);
	if (!url) {
		sendApiError(res, ApiErr.validationError('url must be an https address'));
		return;
	}
	const preview = await previewOf(url);
	if (!preview) {
		res.setHeader('Cache-Control', `private, max-age=${KEEP_SECONDS / 12}`);
		sendApiError(res, ApiErr.notFound('link preview'));
		return;
	}
	res.setHeader('Cache-Control', `private, max-age=${KEEP_SECONDS}`);
	res.status(200).json(preview);
}

/**
 * `GET /api/link-previews/image?url=`: the picture of a card, passed through from the page's own
 * host, only where it is a picture a browser draws without running anything (not an SVG), and
 * served with a policy that lets it run nothing.
 */
export async function handleLinkPreviewImageRoute(req: Request, res: Response): Promise<void> {
	const signed = await signedIn(req.headers);
	if (signed.isErr()) {
		sendApiError(res, signed.error);
		return;
	}
	const url = queryUrl(req);
	const fetched = url ? await get(url, 'image/*', IMAGE_MAX_BYTES) : null;
	const type = fetched?.isOk() ? fetched.value.type.split(';')[0]?.trim() ?? '' : '';
	if (!fetched || fetched.isErr() || !SAFE_IMAGES.test(type) || fetched.value.bytes.byteLength === 0) {
		res.setHeader('Cache-Control', `private, max-age=${KEEP_SECONDS / 12}`);
		sendApiError(res, ApiErr.notFound('link preview image'));
		return;
	}
	res
		.status(200)
		.setHeader('Content-Type', type)
		.setHeader('Cache-Control', `private, max-age=${KEEP_SECONDS}`)
		.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox")
		.setHeader('X-Content-Type-Options', 'nosniff')
		.end(Buffer.from(fetched.value.bytes));
}

