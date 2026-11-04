import {readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';

import {app, screen, type BrowserWindow, type Rectangle} from 'electron';
import {Result} from 'ts-results-es';
import {z} from 'zod';

// The window as it was last closed, so it opens the same size in the same place.

const DEFAULT_BOUNDS = {width: 1440, height: 900};

const boundsSchema = z.object({
	x: z.number(),
	y: z.number(),
	width: z.number(),
	height: z.number(),
});

function stateFile(): string {
	return path.join(app.getPath('userData'), 'window-state.json');
}

// No file yet, or not what the app wrote, is the default size.
function readSavedBounds(): Rectangle | null {
	const saved = Result.wrap(() => JSON.parse(readFileSync(stateFile(), 'utf8')));
	if (saved.isErr()) {
		return null;
	}

	const parsed = boundsSchema.safeParse(saved.value);
	if (!parsed.success) {
		return null;
	}

	// A display since unplugged would put the window off every screen.
	const bounds = parsed.data;
	const visible = screen.getAllDisplays().some((display) => {
		const area = display.workArea;
		return (
			bounds.x < area.x + area.width &&
			bounds.x + bounds.width > area.x &&
			bounds.y < area.y + area.height &&
			bounds.y + bounds.height > area.y
		);
	});
	if (!visible) {
		return null;
	}

	return bounds;
}

export function initialWindowBounds(): Electron.BrowserWindowConstructorOptions {
	return readSavedBounds() ?? DEFAULT_BOUNDS;
}

export function keepWindowBounds(win: BrowserWindow): void {
	win.on('close', () => {
		if (win.isFullScreen() || win.isMinimized()) {
			return;
		}

		// Opening at the default size next time is no loss worth reporting.
		Result.wrap(() => writeFileSync(stateFile(), JSON.stringify(win.getNormalBounds())));
	});
}
