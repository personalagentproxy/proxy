import {useCallback, useState} from 'react';
import {Result} from 'ts-results-es';
import {browserStorage} from '@proxy/ui/lib/theme';

function storedWidth(storage: Storage | null, key: string): number | null {
	if (!storage) {
		return null;
	}
	const read = Result.wrap(() => storage.getItem(key));
	if (read.isErr() || read.value === null) {
		return null;
	}
	const width = Number(read.value);
	return Number.isFinite(width) && width > 0 ? width : null;
}

/**
 * A column's width in pixels as the person dragged it (components/resize-handle.tsx), kept on this
 * device under `key`, as the theme is, so it stays as they left it after a reload. Null until they
 * drag it, and once they reset it: the column's own width then.
 */
export function useStoredWidth(key: string): {
	width: number | null;
	setWidth: (width: number | null) => void;
} {
	const [storage] = useState(() => browserStorage());
	const [width, setWidthState] = useState(() => storedWidth(storage, key));
	const setWidth = useCallback(
		(next: number | null) => {
			setWidthState(next);
			if (!storage) {
				return;
			}
			if (next === null) {
				Result.wrap(() => storage.removeItem(key));
				return;
			}
			Result.wrap(() => storage.setItem(key, String(Math.round(next))));
		},
		[storage, key],
	);
	return {width, setWidth};
}
