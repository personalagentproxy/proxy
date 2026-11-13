import {ArrowLeftIcon, ArrowRightIcon} from 'lucide-react';
import {useEffect, useSyncExternalStore} from 'react';
import {useNavigate} from 'react-router';
import {IconButton} from '@/components/icon-button';

// The mouse's side buttons, as `MouseEvent.button` numbers them.
const MOUSE_BACK = 3;
const MOUSE_FORWARD = 4;

function subscribe(onChange: () => void): () => void {
	navigation.addEventListener('currententrychange', onChange);
	return () => navigation.removeEventListener('currententrychange', onChange);
}

/**
 * Back and forward at the right of the navigation's top row (title-bar.tsx). They step through
 * the window's history, kept by the Navigation API, which counts only the app's own pages, never
 * the desktop app's splash pages (`data:`) shown before it. Nothing in a browser without the API.
 */
export function HistoryButtons() {
	if (typeof navigation === 'undefined') {
		return null;
	}
	return <Buttons />;
}

function Buttons() {
	const navigate = useNavigate();
	const canGoBack = useSyncExternalStore(subscribe, () => navigation.canGoBack);
	const canGoForward = useSyncExternalStore(subscribe, () => navigation.canGoForward);
	return (
		<>
			<IconButton label="Back" disabled={!canGoBack} onClick={() => void navigate(-1)}>
				<ArrowLeftIcon className="size-4" />
			</IconButton>
			<IconButton label="Forward" disabled={!canGoForward} onClick={() => void navigate(1)}>
				<ArrowRightIcon className="size-4" />
			</IconButton>
		</>
	);
}

/**
 * In the desktop app, which has no browser's keys for it: back and forward on ⌘[ and ⌘], and on a
 * mouse's side buttons, on every page. A browser does both itself.
 */
export function DesktopHistoryKeys() {
	const navigate = useNavigate();

	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (!event.metaKey || event.altKey || event.ctrlKey || event.shiftKey) {
				return;
			}
			if (event.key === '[') {
				event.preventDefault();
				void navigate(-1);
				return;
			}
			if (event.key === ']') {
				event.preventDefault();
				void navigate(1);
			}
		};
		const onMouseUp = (event: MouseEvent) => {
			if (event.button === MOUSE_BACK) {
				void navigate(-1);
				return;
			}
			if (event.button === MOUSE_FORWARD) {
				void navigate(1);
			}
		};
		window.addEventListener('keydown', onKeyDown);
		window.addEventListener('mouseup', onMouseUp);
		return () => {
			window.removeEventListener('keydown', onKeyDown);
			window.removeEventListener('mouseup', onMouseUp);
		};
	}, [navigate]);

	return null;
}
