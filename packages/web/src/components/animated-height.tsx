import {useEffect, useRef, useState, type ReactNode} from 'react';

// Grows and shrinks to fit what is in it, smoothly, and folds away when closed: the height CSS can't
// animate to `auto`, so it is measured as the content changes; open before it is first measured,
// it is as tall as what is in it. Closed, it keeps what it showed, so folding away doesn't empty it
// first, and makes it inert.
export function AnimatedHeight({open, children}: {open: boolean; children: ReactNode}) {
	const inner = useRef<HTMLDivElement>(null);
	const [height, setHeight] = useState<number | undefined>(undefined);

	useEffect(() => {
		const element = inner.current;
		if (!element) {
			return;
		}
		const observer = new ResizeObserver(() => setHeight(element.offsetHeight));
		observer.observe(element);
		return () => observer.disconnect();
	}, []);

	return (
		<div
			inert={!open}
			className="overflow-hidden transition-[height] duration-300 ease-out motion-reduce:transition-none"
			style={{height: open ? height : 0}}
		>
			<div ref={inner}>{children}</div>
		</div>
	);
}
