import {describe, expect, test} from 'bun:test';
import sharp from 'sharp';

import {toPicture} from './picture';

// Pictures made here, as a camera or a screen would make them.
function noise(width: number, height: number) {
	return sharp({create: {width, height, channels: 3, background: {r: 200, g: 120, b: 40}, noise: {type: 'gaussian', mean: 128, sigma: 60}}});
}

async function sizeOf(picture: {data: string} | null) {
	const {width, height, format} = await sharp(Buffer.from(picture?.data ?? '', 'base64')).metadata();
	return {width, height, format};
}

describe('toPicture', () => {
	test('gives a small picture as it is, a screenshot as PNG and a photograph as JPEG, under the file’s name', async () => {
		const screenshot = await sharp({create: {width: 320, height: 180, channels: 3, background: '#2e6edc'}})
			.png()
			.toBuffer();
		const photo = await noise(640, 480).jpeg().toBuffer();

		const shown = await toPicture('chart.png', screenshot);
		expect(shown).toMatchObject({name: 'chart.png', mediaType: 'image/png'});
		expect(await sizeOf(shown)).toEqual({width: 320, height: 180, format: 'png'});
		expect(await toPicture('photo.jpg', photo)).toMatchObject({name: 'photo.jpg', mediaType: 'image/jpeg'});
	});

	test('fits a large photograph within the side a model looks at, and under what one takes', async () => {
		const photo = await noise(4032, 3024).jpeg({quality: 95}).toBuffer();
		expect(photo.length).toBeGreaterThan(5_000_000);

		const shown = await toPicture('holiday.jpg', photo);

		expect(await sizeOf(shown)).toEqual({width: 1568, height: 1176, format: 'jpeg'});
		expect(Buffer.from(shown?.data ?? '', 'base64').length).toBeLessThan(3_500_000);
	});

	test('sends a picture too heavy as PNG as JPEG, and one with parts that show through as PNG', async () => {
		const heavy = await noise(1568, 1568).png({compressionLevel: 0}).toBuffer();
		const seeThrough = await sharp({create: {width: 64, height: 64, channels: 4, background: {r: 0, g: 0, b: 0, alpha: 0.5}}})
			.webp()
			.toBuffer();

		expect((await toPicture('noise.png', heavy))?.mediaType).toBe('image/jpeg');
		expect((await toPicture('logo.webp', seeThrough))?.mediaType).toBe('image/png');
	});

	test('is none for a file that only calls itself a picture', async () => {
		expect(await toPicture('pic.png', new TextEncoder().encode('\u0089PNG\r\n\u001a\n fake'))).toBeNull();
		expect(await toPicture('empty.png', new Uint8Array())).toBeNull();
	});
});
