/**
 * What changed between two texts, a line at a time, as a note's history shows it: the lines both
 * have, and those taken out and put in, in order. By their longest common run of lines; texts too
 * long to compare that way, which notes never are, show as all taken out and all put in.
 */

export type DiffLine = {kind: 'same' | 'removed' | 'added'; text: string};

// How many line pairs are compared at most.
const MAX_CELLS = 4_000_000;

function linesOf(text: string): string[] {
	return text === '' ? [] : text.replace(/\n$/, '').split('\n');
}

export function diffLines(before: string, after: string): DiffLine[] {
	const a = linesOf(before);
	const b = linesOf(after);
	if (a.length * b.length > MAX_CELLS) {
		return [
			...a.map((text) => ({kind: 'removed' as const, text})),
			...b.map((text) => ({kind: 'added' as const, text})),
		];
	}
	// How long the longest common run is from each pair of places on.
	const width = b.length + 1;
	const longest = new Uint32Array((a.length + 1) * width);
	for (let i = a.length - 1; i >= 0; i--) {
		for (let j = b.length - 1; j >= 0; j--) {
			longest[i * width + j] =
				a[i] === b[j]
					? (longest[(i + 1) * width + j + 1] ?? 0) + 1
					: Math.max(longest[(i + 1) * width + j] ?? 0, longest[i * width + j + 1] ?? 0);
		}
	}
	const lines: DiffLine[] = [];
	let i = 0;
	let j = 0;
	while (i < a.length && j < b.length) {
		if (a[i] === b[j]) {
			lines.push({kind: 'same', text: a[i] ?? ''});
			i++;
			j++;
			continue;
		}
		if ((longest[(i + 1) * width + j] ?? 0) >= (longest[i * width + j + 1] ?? 0)) {
			lines.push({kind: 'removed', text: a[i] ?? ''});
			i++;
			continue;
		}
		lines.push({kind: 'added', text: b[j] ?? ''});
		j++;
	}
	return [
		...lines,
		...a.slice(i).map((text) => ({kind: 'removed' as const, text})),
		...b.slice(j).map((text) => ({kind: 'added' as const, text})),
	];
}
