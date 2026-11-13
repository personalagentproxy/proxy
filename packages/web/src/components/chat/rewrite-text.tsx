import {useEffect, useState} from 'react';

// How the text is rewritten: the old one taken away from its end back to where the two differ, in
// at most ERASE_FRAMES steps, and the new one written in after it, in at most TYPE_FRAMES, a frame
// every FRAME_MS: under three quarters of a second however long either is.
const ERASE_FRAMES = 12;
const TYPE_FRAMES = 30;
const FRAME_MS = 16;

function reducedMotion(): boolean {
	return (
		typeof window !== 'undefined' &&
		typeof window.matchMedia === 'function' &&
		window.matchMedia('(prefers-reduced-motion: reduce)').matches
	);
}

// How many characters the two texts start with alike.
function sharedStart(a: string, b: string): number {
	let at = 0;
	while (at < a.length && at < b.length && a[at] === b[at]) {
		at += 1;
	}
	return at;
}

// A rewrite under way: the text it started from, and what is shown of it so far.
type Rewrite = {old: string; shown: string};

/**
 * Text that rewrites itself as it changes, as if typed over: what it said is taken away from its
 * end back to where the two differ, and what it says now written in, with a caret at the end while
 * it is. It shows `text` as it is when it first draws, or rewrites it there from `from`, what
 * stood in its place before it was drawn, as a thread's message does as its title comes. Changed
 * again midway, it is rewritten from what it shows then. With less motion asked for, the new text
 * is there at once. While it is being rewritten, what is read out is the new text whole.
 */
export function RewriteText({text, from}: {text: string; from?: string | null}) {
	const [last, setLast] = useState(from ?? text);
	const [rewrite, setRewrite] = useState<Rewrite | null>(null);
	if (last !== text) {
		const shown = rewrite?.shown ?? last;
		setLast(text);
		setRewrite(reducedMotion() ? null : {old: shown, shown});
	}
	const old = rewrite?.old ?? null;

	useEffect(() => {
		if (old === null) {
			return;
		}
		const keep = sharedStart(old, text);
		const eraseStep = Math.max(1, Math.ceil((old.length - keep) / ERASE_FRAMES));
		const typeStep = Math.max(1, Math.ceil((text.length - keep) / TYPE_FRAMES));
		let length = old.length;
		let erasing = length > keep;
		const timer = setInterval(() => {
			if (erasing) {
				length = Math.max(keep, length - eraseStep);
				erasing = length > keep;
				setRewrite({old, shown: old.slice(0, length)});
				return;
			}
			length = Math.min(text.length, length + typeStep);
			if (length === text.length) {
				clearInterval(timer);
				setRewrite(null);
				return;
			}
			setRewrite({old, shown: text.slice(0, length)});
		}, FRAME_MS);
		return () => clearInterval(timer);
	}, [old, text]);

	if (rewrite === null) {
		return <>{text}</>;
	}
	return (
		<>
			<span aria-hidden>
				{rewrite.shown}
				<span
					data-slot="rewrite-caret"
					className="ml-px inline-block h-[1em] w-px translate-y-[0.15em] bg-current"
				/>
			</span>
			<span className="sr-only">{text}</span>
		</>
	);
}
