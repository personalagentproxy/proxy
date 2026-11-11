import {useCallback, useState} from 'react';
import {Result} from 'ts-results-es';
import {browserStorage} from '@proxy/ui/lib/theme';

// How wide the second sidebar (AppShell's `panel`) is on desktop, in pixels: 16rem until the person
// drags its edge, never narrower than a row's head and a few words beside it, nor so wide that the
// page beside it is squeezed. Kept on this device, as the theme is, so it is as wide after a reload.
export const PANEL_DEFAULT_WIDTH = 256;
export const PANEL_MIN_WIDTH = 208;
export const PANEL_MAX_WIDTH = 480;

const STORAGE_KEY = 'proxy-panel-width';

/** The width within the bounds, in whole pixels. */
export function clampPanelWidth(width: number): number {
	return Math.round(Math.min(PANEL_MAX_WIDTH, Math.max(PANEL_MIN_WIDTH, width)));
}

/** The width kept on this device, or null where there is none, it is not a number, or storage is blocked. */
export function storedPanelWidth(storage: Pick<Storage, 'getItem'> | null): number | null {
	if (!storage) {
		return null;
	}
	const read = Result.wrap(() => storage.getItem(STORAGE_KEY));
	if (read.isErr() || read.value === null) {
		return null;
	}
	const width = Number(read.value);
	if (!Number.isFinite(width)) {
		return null;
	}
	return clampPanelWidth(width);
}

export type PanelWidth = {
	width: number;
	// Sets the width as it is dragged, without keeping it.
	preview: (width: number) => void;
	// Sets the width and keeps it on this device.
	commit: (width: number) => void;
	// Back to the default, which is kept by forgetting the one set.
	reset: () => void;
};

export function usePanelWidth(): PanelWidth {
	const [storage] = useState(() => browserStorage());
	const [width, setWidth] = useState(() => storedPanelWidth(storage) ?? PANEL_DEFAULT_WIDTH);

	const preview = useCallback((next: number) => setWidth(clampPanelWidth(next)), []);
	const commit = useCallback(
		(next: number) => {
			const clamped = clampPanelWidth(next);
			setWidth(clamped);
			if (!storage) {
				return;
			}
			Result.wrap(() => storage.setItem(STORAGE_KEY, String(clamped)));
		},
		[storage],
	);
	const reset = useCallback(() => {
		setWidth(PANEL_DEFAULT_WIDTH);
		if (!storage) {
			return;
		}
		Result.wrap(() => storage.removeItem(STORAGE_KEY));
	}, [storage]);

	return {width, preview, commit, reset};
}
