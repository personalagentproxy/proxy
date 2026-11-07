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

// Back and forward in the desktop app's title bar, beside the traffic lights, where a browser has
// its own: the window has none. They step through the window's history, kept by the Navigation
// API, which counts only the app's own pages, never the splash pages (`data:`) shown before it.
// ⌘[ and ⌘], and a mouse's side buttons, do the same. After them come the page's controls, then
// its title, in the slots given to `controlsRef` and `titleRef` (title-bar-slot.tsx).
export function DesktopHistory({
	controlsRef,
	titleRef,
}: {
	controlsRef?: (slot: HTMLElement | null) => void;
	titleRef?: (slot: HTMLElement | null) => void;
}) {
	const navigate = useNavigate();
	const canGoBack = useSyncExternalStore(subscribe, () => navigation.canGoBack);
	const canGoForward = useSyncExternalStore(subscribe, () => navigation.canGoForward);

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

	return (
		<div data-desktop-history className="flex items-center gap-0.5">
			<IconButton label="Back" size="xs" disabled={!canGoBack} onClick={() => void navigate(-1)}>
				<ArrowLeftIcon className="size-4" />
			</IconButton>
			<IconButton
				label="Forward"
				size="xs"
				disabled={!canGoForward}
				onClick={() => void navigate(1)}
			>
				<ArrowRightIcon className="size-4" />
			</IconButton>
			<div ref={controlsRef} className="contents" />
			<div ref={titleRef} data-desktop-title className="flex min-w-0 items-center gap-2 pl-2.5" />
		</div>
	);
}
