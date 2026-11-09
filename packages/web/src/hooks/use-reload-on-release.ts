import {useEffect, useRef} from 'react';
import {useLocation} from 'react-router';
import {useNewRelease} from '@/hooks/use-new-release';
import {hasWriteInFlight} from '@/lib/writes-in-flight';

// How often a tab out of view is looked at again, once there is a new release.
const RETRY_MS = 3 * 1000;

// How many pages say a reload loses them nothing, for now (`useReloadWhileHidden`).
let pagesSafeToReload = 0;

function reloadPage(): void {
	window.location.reload();
}

/**
 * Says the page loses nothing to a reload while `safe`: nothing typed and not kept, no dialog
 * open, nothing shown that can't be loaded again. A new release is then loaded while the tab is
 * out of view, too, not only at the next page.
 */
export function useReloadWhileHidden(safe: boolean): void {
	useEffect(() => {
		if (!safe) {
			return;
		}

		pagesSafeToReload += 1;
		return () => {
			pagesSafeToReload -= 1;
		};
	}, [safe]);
}

// Once the server has a new release of the web app, reloads the page into it, without a word,
// where that loses nothing: as the person moves to another page, which leaves behind whatever the
// last one held, or, on a page that says so (`useReloadWhileHidden`), while the tab is out of
// view. Never while a write is on its way, which the reload would cut off: a page moved to then
// waits for the next one.
export function useReloadOnRelease(reload: () => void = reloadPage): void {
	const newRelease = useNewRelease();
	const {pathname} = useLocation();
	const reloaded = useRef(false);
	const lastPathname = useRef(pathname);

	useEffect(() => {
		if (pathname === lastPathname.current) {
			return;
		}

		lastPathname.current = pathname;
		if (!newRelease || reloaded.current || hasWriteInFlight()) {
			return;
		}

		reloaded.current = true;
		reload();
	}, [newRelease, pathname, reload]);

	useEffect(() => {
		if (!newRelease) {
			return;
		}

		const attempt = () => {
			if (reloaded.current || document.visibilityState !== 'hidden') {
				return;
			}

			if (pagesSafeToReload === 0 || hasWriteInFlight()) {
				return;
			}

			reloaded.current = true;
			reload();
		};

		attempt();
		const timer = setInterval(attempt, RETRY_MS);
		document.addEventListener('visibilitychange', attempt);

		return () => {
			clearInterval(timer);
			document.removeEventListener('visibilitychange', attempt);
		};
	}, [newRelease, reload]);
}
