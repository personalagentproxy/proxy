import {type HeadSpec, loadStage, paintHead, REST} from '@/lib/head';

// The picture's side, in pixels: Slack takes an app's picture from 512 to 2000 pixels square.
const SIDE = 1024;
// How much of the side the head takes, so it has room around it as in the page's circles.
const HEAD = 0.8;

// The page's own background, which the head is drawn for: a head in the page's ink is near-black
// on a light page and white on a dark one. White where the page says none.
function pageBackground(): string {
	const color = getComputedStyle(document.body).backgroundColor;
	return color === '' || color === 'transparent' || color === 'rgba(0, 0, 0, 0)'
		? '#ffffff'
		: color;
}

/**
 * A persona's head as a square PNG on a plain background, the page's, drawn as the page draws it
 * at rest, for an app's picture where it can only be set by hand, as in Slack. Null where heads
 * can't be drawn, as without WebGL.
 */
export async function headPicture(spec: HeadSpec): Promise<Blob | null> {
	const stage = await loadStage();
	if (!stage) {
		return null;
	}
	const head = document.createElement('canvas');
	const size = Math.round(SIDE * HEAD);
	paintHead(stage, head, spec, REST, size, false);
	const picture = document.createElement('canvas');
	picture.width = SIDE;
	picture.height = SIDE;
	const context = picture.getContext('2d');
	if (!context) {
		return null;
	}
	context.fillStyle = pageBackground();
	context.fillRect(0, 0, SIDE, SIDE);
	const at = Math.round((SIDE - size) / 2);
	context.drawImage(head, at, at);
	return new Promise((resolve) => picture.toBlob(resolve, 'image/png'));
}

/** Saves the head's picture as `<name>.png`; false where it couldn't be drawn. */
export async function downloadHeadPicture(spec: HeadSpec, name: string): Promise<boolean> {
	const picture = await headPicture(spec);
	if (!picture) {
		return false;
	}
	const url = URL.createObjectURL(picture);
	const link = document.createElement('a');
	link.href = url;
	link.download = `${name.trim() || 'agent'}.png`;
	link.click();
	URL.revokeObjectURL(url);
	return true;
}
