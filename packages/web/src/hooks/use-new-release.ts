import {useCallback, useState} from 'react';
import {usePoll} from '@/hooks/use-poll';
import {hasNewRelease} from '@/lib/release';

// Whether the server has a newer release of the web app than the page: asked every so often,
// and when the page comes back into view, if that has not just been asked. Once true, stays so.

const CHECK_INTERVAL_MS = 10 * 60 * 1000;
const VISIBLE_CHECK_GAP_MS = 60 * 1000;

export function useNewRelease(): boolean {
	const [newRelease, setNewRelease] = useState(false);

	const check = useCallback((signal: AbortSignal) => {
		void hasNewRelease(document).then((found) => {
			if (!signal.aborted && found) {
				setNewRelease(true);
			}
		});
	}, []);
	usePoll(check, {
		enabled: !newRelease,
		intervalMs: CHECK_INTERVAL_MS,
		visibleGapMs: VISIBLE_CHECK_GAP_MS,
		immediate: false,
	});

	return newRelease;
}
