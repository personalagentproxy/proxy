import {useEffect, useRef} from 'react';
import {useLocation} from 'react-router';
import {useNewRelease} from '@/hooks/use-new-release';
import {hasWriteInFlight} from '@/lib/writes-in-flight';

// How often a tab out of view is looked at again, once there is a new release.
const RETRY_MS = 3 * 1000;

// How many parts of the page in view say whether a reload loses them anything, and how many of
// them say it loses nothing, for now (`useReloadWhileHidden`).
let partsSaying = 0;
let partsSafeToReload = 0;

/**
 * Whether the page in view says a reload loses it nothing, for now (`useReloadWhileHidden`): every
 * part of it that says so at all does, as a chat's box and its open thread's each do, and one
 * holding something unsent keeps the page.
 */
export function pageSaysSafeToReload(): boolean {
	return partsSaying > 0 && partsSafeToReload === partsSaying;
}

function reloadPage(): void {
	window.location.reload();
}

/**
 * Says this part of the page loses nothing to a reload while `safe`: nothing typed and not kept,
 * no dialog open, nothing shown that can't be loaded again. A new release is then loaded while the
 * tab is out of view, too, not only at the next page, as long as every part that says so agrees.
 */
export function useReloadWhileHidden(safe: boolean): void {
	useEffect(() => {
		partsSaying += 1;
		partsSafeToReload += safe ? 1 : 0;
		return () => {
			partsSaying -= 1;
			partsSafeToReload -= safe ? 1 : 0;
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

			if (!pageSaysSafeToReload() || hasWriteInFlight()) {
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
