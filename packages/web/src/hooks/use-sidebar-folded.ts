import {useCallback, useState} from 'react';
import {Result} from 'ts-results-es';
import {browserStorage} from '@proxy/ui/lib/theme';

// Whether the person folded the navigation away on desktop. Out until they do; kept on this device,
// as the theme is, so it stays as they left it after a reload.
const STORAGE_KEY = 'proxy-sidebar-folded';

function storedFolded(storage: Storage | null): boolean {
	if (!storage) {
		return false;
	}
	const read = Result.wrap(() => storage.getItem(STORAGE_KEY));
	return read.isOk() && read.value === 'true';
}

export function useSidebarFolded(): {folded: boolean; setFolded: (folded: boolean) => void} {
	const [storage] = useState(() => browserStorage());
	const [folded, setFoldedState] = useState(() => storedFolded(storage));
	const setFolded = useCallback(
		(next: boolean) => {
			setFoldedState(next);
			if (!storage) {
				return;
			}
			Result.wrap(() => storage.setItem(STORAGE_KEY, String(next)));
		},
		[storage],
	);
	return {folded, setFolded};
}
