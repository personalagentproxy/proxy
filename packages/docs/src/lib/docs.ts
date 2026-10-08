import {readdir, readFile} from 'node:fs/promises';
import path from 'node:path';
import {cache} from 'react';
import * as runtime from 'react/jsx-runtime';
import {evaluate} from '@mdx-js/mdx';
import rehypeShiki from '@shikijs/rehype';
import type {Root} from 'hast';
import {toString} from 'hast-util-to-string';
import type {MDXContent} from 'mdx/types';
import rehypeSlug from 'rehype-slug';
import remarkGfm from 'remark-gfm';
import {Err, Ok, Result} from 'ts-results-es';
import {visit} from 'unist-util-visit';
import {VFile} from 'vfile';
import {matter} from 'vfile-matter';
import {z} from 'zod';
import {Do} from '@proxy/utils';
import {NAV, type NavEntry} from '@/nav';

const CONTENT_DIR = path.join(process.cwd(), 'content');

const frontmatterSchema = z.strictObject({
	title: z.string().min(1),
	// The line under the title, and the page's meta description.
	description: z.string().min(1),
});

export type Frontmatter = z.infer<typeof frontmatterSchema>;

export type NavPage = {slug: string; href: string; title: string};
// A sidebar row, with the pages nested under it and whether they are always folded out.
export type NavItem = NavPage & {pages: NavPage[]; open: boolean};
// `pages` is every page in the section in order, nested ones included.
export type NavSection = {title: string; items: NavItem[]; pages: NavPage[]};
export type Nav = {sections: NavSection[]; pages: NavPage[]};

export type Heading = {id: string; text: string; depth: 2 | 3};

export type DocPage = {
	frontmatter: Frontmatter;
	Content: MDXContent;
	// The h2s and h3s, for the page's table of contents.
	headings: Heading[];
};

// With a trailing slash, as the export writes each page as `<path>/index.html`.
export function hrefFor(slug: string): string {
	return slug === '' ? '/' : `/${slug}/`;
}

// The slug of every .mdx file, mapped to its path: `self-hosting/get-started.mdx` is
// `self-hosting/get-started`, and a folder's `index.mdx` is the folder.
async function listFiles(): Promise<Result<Map<string, string>, Error>> {
	const entries = await Result.wrapAsync(() => readdir(CONTENT_DIR, {recursive: true}));
	if (entries.isErr()) {
		return Err(new Error(`Could not read ${CONTENT_DIR}`, {cause: entries.error}));
	}

	const files = new Map<string, string>();
	for (const entry of entries.value) {
		if (!entry.endsWith('.mdx')) {
			continue;
		}

		const slug = entry
			.slice(0, -'.mdx'.length)
			.split(path.sep)
			.join('/')
			.replace(/(^|\/)index$/, '');
		files.set(slug, path.join(CONTENT_DIR, entry));
	}
	return Ok(files);
}

// Reads a file and splits off its frontmatter, which is checked against the schema.
async function readPage(
	file: string,
): Promise<Result<{vfile: VFile; frontmatter: Frontmatter}, Error>> {
	const source = await Result.wrapAsync(() => readFile(file, 'utf8'));
	if (source.isErr()) {
		return Err(new Error(`Could not read ${file}`, {cause: source.error}));
	}

	const vfile = new VFile({path: file, value: source.value});
	matter(vfile, {strip: true});

	const frontmatter = frontmatterSchema.safeParse(vfile.data.matter);
	if (!frontmatter.success) {
		return Err(new Error(`Bad frontmatter in ${file}: ${z.prettifyError(frontmatter.error)}`));
	}
	return Ok({vfile, frontmatter: frontmatter.data});
}

function withNested(entry: NavEntry): {page: string; pages: string[]; open: boolean} {
	if (typeof entry === 'string') {
		return {page: entry, pages: [], open: false};
	}
	return {...entry, open: entry.open ?? false};
}

// NAV with each page's title, checked against the files in content/.
export const loadNav = cache(async (): Promise<Result<Nav, Error>> => {
	return Do(async ($) => {
		const files = $(await listFiles());
		const listed = NAV.flatMap((section) =>
			section.pages.flatMap((entry) => {
				const {page, pages} = withNested(entry);
				return [page, ...pages];
			}),
		);

		const unlisted = [...files.keys()].filter((slug) => !listed.includes(slug));
		if (unlisted.length > 0) {
			return $(Err(new Error(`Pages missing from src/nav.ts: ${unlisted.join(', ')}`)));
		}

		const loadNavPage = async (slug: string): Promise<Result<NavPage, Error>> => {
			const file = files.get(slug);
			if (!file) {
				return Err(new Error(`src/nav.ts lists "${slug}", which has no file in content/`));
			}

			const read = await readPage(file);
			return read.map(({frontmatter}) => ({slug, href: hrefFor(slug), title: frontmatter.title}));
		};

		const sections: NavSection[] = [];
		for (const section of NAV) {
			const items: NavItem[] = [];
			for (const entry of section.pages) {
				const {page: slug, pages: nested, open} = withNested(entry);
				const page = $(await loadNavPage(slug));
				const pages: NavPage[] = [];
				for (const nestedSlug of nested) {
					pages.push($(await loadNavPage(nestedSlug)));
				}
				items.push({...page, pages, open});
			}
			sections.push({
				title: section.title,
				items,
				pages: items.flatMap((item) => [item, ...item.pages]),
			});
		}

		return {sections, pages: sections.flatMap((section) => section.pages)};
	});
});

// Collects the h2s and h3s into `headings`. Runs after rehype-slug, which gives them their ids.
function rehypeHeadings(headings: Heading[]) {
	return () => (tree: Root) => {
		visit(tree, 'element', (node) => {
			if (node.tagName !== 'h2' && node.tagName !== 'h3') {
				return;
			}

			headings.push({
				id: String(node.properties.id),
				text: toString(node),
				depth: node.tagName === 'h2' ? 2 : 3,
			});
		});
	};
}

export async function loadPage(slug: string): Promise<Result<DocPage, Error>> {
	return Do(async ($) => {
		const files = $(await listFiles());
		const file = files.get(slug);
		if (!file) {
			return $(Err(new Error(`No page at content/${slug}`)));
		}

		const {vfile, frontmatter} = $(await readPage(file));
		const headings: Heading[] = [];

		const compiled = await Result.wrapAsync(() =>
			evaluate(vfile, {
				...runtime,
				remarkPlugins: [remarkGfm],
				rehypePlugins: [
					rehypeSlug,
					rehypeHeadings(headings),
					[
						rehypeShiki,
						{
							// Both themes ship as CSS variables; globals.css picks one by the theme class.
							themes: {light: 'github-light', dark: 'github-dark'},
							defaultColor: false,
							defaultLanguage: 'text',
						},
					],
				],
			}),
		);
		if (compiled.isErr()) {
			return $(Err(new Error(`Could not compile ${file}`, {cause: compiled.error})));
		}

		return {frontmatter, Content: compiled.value.default, headings};
	});
}
