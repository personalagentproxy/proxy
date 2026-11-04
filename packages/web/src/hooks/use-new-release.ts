import {useEffect, useState} from 'react';
import {hasNewRelease} from '@/lib/release';

// Whether the server has a newer release of the web app than the page: asked every so often,
// and when the page comes back into view, if that has not just been asked. Once true, stays so.

const CHECK_INTERVAL_MS = 10 * 60 * 1000;
const VISIBLE_CHECK_GAP_MS = 60 * 1000;

export function useNewRelease(): boolean {
	const [newRelease, setNewRelease] = useState(false);

	useEffect(() => {
		if (newRelease) {
			return;
		}

		let cancelled = false;
		let lastCheck = Date.now();

		const check = async () => {
			lastCheck = Date.now();
			const found = await hasNewRelease(document);
			if (!cancelled && found) {
				setNewRelease(true);
			}
		};

		const onVisible = () => {
			if (document.visibilityState !== 'visible') {
				return;
			}
			if (Date.now() - lastCheck < VISIBLE_CHECK_GAP_MS) {
				return;
			}
			void check();
		};

		const timer = setInterval(() => void check(), CHECK_INTERVAL_MS);
		document.addEventListener('visibilitychange', onVisible);
		window.addEventListener('focus', onVisible);

		return () => {
			cancelled = true;
			clearInterval(timer);
			document.removeEventListener('visibilitychange', onVisible);
			window.removeEventListener('focus', onVisible);
		};
	}, [newRelease]);

	return newRelease;
}
