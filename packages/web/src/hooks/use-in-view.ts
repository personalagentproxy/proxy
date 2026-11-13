import {useEffect, useState} from 'react';

/**
 * Whether any of `element` is in view: drawn, not in something hidden, and not scrolled out of
 * what holds it. False with no element; true where the browser can't say.
 */
export function useInView(element: Element | null): boolean {
	const [seen, setSeen] = useState<{element: Element; inView: boolean} | null>(null);

	useEffect(() => {
		if (element === null || typeof IntersectionObserver === 'undefined') {
			return;
		}
		const observer = new IntersectionObserver((entries) => {
			const last = entries.at(-1);
			if (last === undefined) {
				return;
			}
			setSeen({element, inView: last.isIntersecting});
		});
		observer.observe(element);
		return () => {
			observer.disconnect();
		};
	}, [element]);

	if (element === null) {
		return false;
	}
	if (typeof IntersectionObserver === 'undefined') {
		return true;
	}
	// What was said of another element says nothing of this one, which the browser has yet to say.
	return seen?.element === element && seen.inView;
}
