import {useEffect, useRef} from 'react';
import {useLocation} from 'react-router';
import {useNewRelease} from '@/hooks/use-new-release';
import {hasUnsavedWork, watchTyping} from '@/lib/unsaved-work';

// How often a page holding unsaved work is looked at again, once there is a new release.
const RETRY_MS = 3 * 1000;

function reloadPage(): void {
	window.location.reload();
}

// Once the server has a new release of the web app, reloads the page into it, without a word, as
// soon as that loses nothing (`hasUnsavedWork`): at once, most often, which is as the page comes
// back into view, when the release is looked for; otherwise at the next move to another page,
// as the tab goes out of view or comes back, or within seconds of the work being done.
export function useReloadOnRelease(reload: () => void = reloadPage): void {
	const newRelease = useNewRelease();
	const {pathname} = useLocation();
	const reloaded = useRef(false);

	useEffect(() => watchTyping(document), []);

	useEffect(() => {
		if (!newRelease) {
			return;
		}

		const attempt = () => {
			if (reloaded.current || hasUnsavedWork(document)) {
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
	}, [newRelease, pathname, reload]);
}
