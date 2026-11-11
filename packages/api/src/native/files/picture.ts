import sharp from 'sharp';
import {Result} from 'ts-results-es';

import type {EntryImage} from '@proxy/utils/harness-context';

/**
 * A picture as a model is given it. What a person attaches is whatever their camera or their
 * screen made, often larger than a model takes and far larger than it sees any better for: it is
 * read, turned the way it was taken, fitted within the side a model looks at, and written again,
 * as PNG where it was one or has parts that show through, as a screenshot or a diagram is, and as
 * JPEG otherwise, as a photograph is; one still too heavy that way goes as JPEG. Reading it at all
 * is the check that it is a picture: a file that only calls itself one is none, and is never sent
 * for a model's provider to turn the whole request down over.
 */

/** The longest side a picture is sent with, in pixels: beyond it a model's provider scales it down itself. */
const PICTURE_SIDE = 1568;

/** The most a picture weighs as sent, in bytes: under what a model's provider takes once it is written as base64. */
const PICTURE_BYTES = 3_500_000;

/** The most pixels a picture is read with: one larger is no picture to show. */
const MAX_PIXELS = 100_000_000;

/** The largest file read as a picture, in bytes. */
export const PICTURE_SOURCE_BYTES = 30 * 1024 * 1024;

type Written = {mediaType: EntryImage['mediaType']; bytes: Buffer};

async function write(bytes: Uint8Array): Promise<Written> {
	const {format, hasAlpha} = await sharp(bytes, {limitInputPixels: MAX_PIXELS}).metadata();
	const fitted = sharp(bytes, {limitInputPixels: MAX_PIXELS}).rotate().resize({width: PICTURE_SIDE, height: PICTURE_SIDE, fit: 'inside', withoutEnlargement: true});
	if (format === 'png' || format === 'gif' || hasAlpha) {
		const png = await fitted.clone().png().toBuffer();
		if (png.length <= PICTURE_BYTES) {
			return {mediaType: 'image/png', bytes: png};
		}
		return {mediaType: 'image/jpeg', bytes: await fitted.clone().flatten({background: '#ffffff'}).jpeg({quality: 80}).toBuffer()};
	}
	return {mediaType: 'image/jpeg', bytes: await fitted.jpeg({quality: 85}).toBuffer()};
}

/** The file's bytes as a picture for a model, under the file's name; null where they can't be read as a picture. */
export async function toPicture(name: string, bytes: Uint8Array): Promise<EntryImage | null> {
	const written = await Result.wrapAsync(() => write(bytes));
	if (written.isErr() || written.value.bytes.length > PICTURE_BYTES) {
		return null;
	}
	return {name, mediaType: written.value.mediaType, data: written.value.bytes.toString('base64')};
}
