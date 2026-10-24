import {useCallback, useState} from 'react';

// How wide a chart is taken to be until it is measured.
const DEFAULT_WIDTH = 600;

/** The width of the element the ref is put on, measured as it resizes: a chart lays out in pixels. */
export function useChartWidth(): [(element: HTMLDivElement | null) => void, number] {
	const [width, setWidth] = useState(DEFAULT_WIDTH);
	const measure = useCallback((element: HTMLDivElement | null) => {
		if (!element) {
			return;
		}
		const read = () => setWidth(element.clientWidth || DEFAULT_WIDTH);
		read();
		if (typeof ResizeObserver === 'undefined') {
			return;
		}
		const observer = new ResizeObserver(read);
		observer.observe(element);
		return () => observer.disconnect();
	}, []);
	return [measure, width];
}
