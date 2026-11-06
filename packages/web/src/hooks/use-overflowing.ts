import {useCallback, useState} from 'react';

/**
 * Whether the element the ref is put on holds more than it shows, so it scrolls: measured as it or
 * what is in it resizes.
 */
export function useOverflowing(): [(element: HTMLElement | null) => void, boolean] {
	const [overflowing, setOverflowing] = useState(false);
	const measure = useCallback((element: HTMLElement | null) => {
		if (!element) {
			return;
		}
		const read = () => setOverflowing(element.scrollHeight > element.clientHeight);
		read();
		if (typeof ResizeObserver === 'undefined') {
			return;
		}
		const observer = new ResizeObserver(read);
		observer.observe(element);
		for (const child of element.children) {
			observer.observe(child);
		}
		return () => observer.disconnect();
	}, []);
	return [measure, overflowing];
}
