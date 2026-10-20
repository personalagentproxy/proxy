import {describe, expect, test} from 'bun:test';

// How the web app lays things out (`@proxy/ui/styles.css`): a container's padding is where text
// starts, a row reaches past it only through `--bleed`, and spacing between things is the gap of
// what holds them. These are the ways back to every part setting its own, each matched where a
// class name starts, after a space or a quote: `@/client/me-client` is no margin.
const RULES = [
	{
		// `mt-2`, `-mx-4`, `md:mb-6`: spacing set on the thing rather than by what holds it. Centering
		// and pushing to one side (`mx-auto`, `ml-auto`) are layout, not spacing, and a row's item out
		// into the gutter (`-mx-(--bleed)`) is how `--bleed` is spent.
		name: 'an outer margin',
		pattern: /(?<=[\s"'`])(?:[a-z]+:)*-?m[trblxyse]?-(?!auto\b|\(--bleed\))[\w.[(]/g,
	},
	{
		// `md:px-3`, `md:pl-2.5`: an inset copied by hand to line up with the rows.
		name: 'a responsive horizontal padding',
		pattern: /(?<=[\s"'`])(?:[a-z]+:)*(?:sm|md|lg|xl|2xl):p[xlrse]-[\w.[(]/g,
	},
];

const SOURCES = [...new Bun.Glob('**/*.{ts,tsx}').scanSync(import.meta.dir)].filter(
	(path) => !/\.test\.tsx?$/.test(path),
);

describe('layout', () => {
	for (const rule of RULES) {
		test(`no part of the app sets ${rule.name}`, async () => {
			const found: string[] = [];
			for (const path of SOURCES) {
				const text = await Bun.file(`${import.meta.dir}/${path}`).text();
				for (const match of text.matchAll(rule.pattern)) {
					const line = text.slice(0, match.index).split('\n').length;
					found.push(`${path}:${line} ${match[0]}`);
				}
			}

			expect(found).toEqual([]);
		});
	}
});
