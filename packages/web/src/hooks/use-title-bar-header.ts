import {useCallback} from 'react';
import {hasHiddenDesktopTitleBar} from '@/lib/desktop';

// The space between the header's contents and the title bar's controls, or the window's edge.
const EDGE_PX = 16;
const GAP_PX = 12;

/**
 * For a page's header, which the desktop app puts in its title bar (index.css). Where the traffic
 * lights, back and forward and the page's controls and title after them (title-bar-slot.tsx) reach
 * into the header, its contents start after them: `--desktop-header-inset`. Measured again as the
 * header or the controls resize, as with the window, a sidebar or a new title. In a browser,
 * nothing.
 */
export function useTitleBarHeader(): (header: HTMLElement | null) => (() => void) | undefined {
	return useCallback((header: HTMLElement | null) => {
		if (!header || !hasHiddenDesktopTitleBar() || typeof ResizeObserver === 'undefined') {
			return;
		}
		const controls = document.querySelector<HTMLElement>('[data-desktop-history]');
		const read = () => {
			const controlsEnd = controls ? controls.getBoundingClientRect().right + GAP_PX : 0;
			const inset = Math.max(EDGE_PX, controlsEnd - header.getBoundingClientRect().left);
			header.style.setProperty('--desktop-header-inset', `${inset}px`);
		};
		read();
		const observer = new ResizeObserver(read);
		observer.observe(header);
		if (controls) {
			observer.observe(controls);
		}
		return () => observer.disconnect();
	}, []);
}
