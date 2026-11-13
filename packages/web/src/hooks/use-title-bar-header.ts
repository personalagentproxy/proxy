import {useCallback} from 'react';
import {hasHiddenDesktopTitleBar} from '@/lib/desktop';

// The space between the header's contents and the title bar's start, or the column's edge.
const EDGE_PX = 16;
const GAP_PX = 12;
// Where the desktop app's traffic lights end, with the gap after them: 5.5rem, as index.css has
// the bar's start begin there.
const LIGHTS_END_PX = 88;

/**
 * For a page's header, its column's cell of the title bar (index.css). Where the bar's start, the
 * desktop app's traffic lights, the navigation's toggle and, while it is out, back and forward
 * (title-bar.tsx), reaches into the header, as where the page's column starts under it, its
 * contents start after it: `--title-bar-inset`. Measured again as the header or the bar's start
 * resize, as with the window or the navigation folded. On the agents' side, which has no
 * navigation, after the traffic lights alone.
 */
export function useTitleBarHeader(): (header: HTMLElement | null) => (() => void) | undefined {
	return useCallback((header: HTMLElement | null) => {
		if (!header || typeof ResizeObserver === 'undefined') {
			return;
		}
		const start = document.querySelector<HTMLElement>('[data-title-bar]');
		const lightsEnd = hasHiddenDesktopTitleBar() ? LIGHTS_END_PX : 0;
		const read = () => {
			const startEnd = start ? start.getBoundingClientRect().right + GAP_PX : lightsEnd;
			const inset = Math.max(EDGE_PX, startEnd - header.getBoundingClientRect().left);
			header.style.setProperty('--title-bar-inset', `${inset}px`);
		};
		read();
		const observer = new ResizeObserver(read);
		observer.observe(header);
		if (start) {
			observer.observe(start);
		}
		return () => observer.disconnect();
	}, []);
}
