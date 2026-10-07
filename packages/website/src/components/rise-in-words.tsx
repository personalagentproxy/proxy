import {Fragment} from 'react';

// One timing for the whole page: the first word rises in after `START_MS`, each next one
// `WORD_STAGGER_MS` later, top to bottom (`.rise-in` in globals.css).
const START_MS = 100;
const WORD_STAGGER_MS = 8;

// The `animation-delay` of the page's `word`th word, counted from the top.
export function riseInDelay(word: number) {
	return `${START_MS + word * WORD_STAGGER_MS}ms`;
}

// Splits `text` into words that rise in one after another, its first being the page's
// `firstWord`th.
export function RiseInWords({text, firstWord}: {text: string; firstWord: number}) {
	return text.split(' ').map((word, index) => (
		<Fragment key={index}>
			{index > 0 && ' '}
			<span
				className="rise-in inline-block"
				style={{animationDelay: riseInDelay(firstWord + index)}}
			>
				{word}
			</span>
		</Fragment>
	));
}
