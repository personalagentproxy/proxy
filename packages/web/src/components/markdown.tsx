import type {Element, ElementContent, Root, RootContent} from 'hast';
import {
	createContext,
	type ReactElement,
	type ReactNode,
	useContext,
	useMemo,
	useState,
} from 'react';
import {ImageIcon} from 'lucide-react';
import ReactMarkdown, {type Components} from 'react-markdown';
import {Link} from 'react-router';
import remarkGfm from 'remark-gfm';
import {cn} from '@proxy/ui/lib/utils';
import {useOrgSlug} from '@/hooks/use-org';
import {accountPath} from '@/lib/orgs';
import {LinkPreviewCard} from './link-preview-card';

const MAX_FAVICON_HOSTS = 8;
const FaviconHostsContext = createContext<Set<string> | null>(null);

// What a persona answers, as Markdown: paragraphs, lists, tables, code and links, styled to sit
// in a chat bubble. A link elsewhere opens in a new tab, since the conversation stays here; one
// into the app, by its path, opens in place. A picture is never loaded from the address it gives,
// since loading it would hand that address whatever the answer put in it, unasked: it is what
// `image` makes of it, a file kept with the answer, or else a link to the address, which the
// person may open. A picture never stands among words: it is taken out of them, onto a line of
// its own, and pictures one after another, with nothing but space between them, share it, a row
// of them, wrapping, as a set of screenshots is shown, not a column of them as tall as the window.
// Each component takes the element's own props, without the syntax tree node
// react-markdown hands along, which is no attribute of an element.

/**
 * A picture of the text as the page shows it, by its address and what it says it shows; null for
 * one the page has nothing for.
 */
export type ImageOf = (src: string, alt: string) => ReactNode | null;

const ImageContext = createContext<ImageOf | null>(null);

function isPicture(node: RootContent | ElementContent): node is Element {
	return node.type === 'element' && node.tagName === 'img';
}

function isBlank(node: RootContent | ElementContent): boolean {
	if (node.type === 'text') {
		return node.value.trim() === '';
	}
	return node.type === 'element' && node.tagName === 'br';
}

// A paragraph of pictures and nothing else but space.
function isPictures(node: RootContent): node is Element {
	if (node.type !== 'element' || node.tagName !== 'p') {
		return false;
	}
	return (
		node.children.some(isPicture) &&
		node.children.every((child) => isPicture(child) || isBlank(child))
	);
}

// Paragraphs of pictures one after another as one, marked as a row of pictures; none for none.
function gallery(run: Element[]): Element[] {
	const pictures = run.flatMap((paragraph) => paragraph.children.filter(isPicture));
	if (pictures.length === 0) {
		return [];
	}
	return [
		{
			type: 'element',
			tagName: 'p',
			properties: {dataPictures: true},
			children: pictures,
		},
	];
}

function paragraph(children: ElementContent[]): Element {
	return {type: 'element', tagName: 'p', properties: {}, children};
}

// Where in a paragraph pictures stand, one or more one after another with nothing but space
// between them: from the first to the last, by index.
function pictureRuns(children: ElementContent[]): Array<[number, number]> {
	const runs: Array<[number, number]> = [];
	let start: number | null = null;
	let end = 0;
	for (const [index, child] of children.entries()) {
		if (isPicture(child)) {
			start ??= index;
			end = index;
			continue;
		}
		if (start !== null && isBlank(child)) {
			continue;
		}
		if (start !== null) {
			runs.push([start, end]);
		}
		start = null;
	}
	if (start !== null) {
		runs.push([start, end]);
	}
	return runs;
}

// A paragraph with pictures among words, as an answer cut short mid-link leaves one too, as a
// paragraph of each run of its pictures between paragraphs of the words around them; any other as
// it is.
function splitPictures(node: RootContent): RootContent[] {
	if (node.type !== 'element' || node.tagName !== 'p') {
		return [node];
	}
	const runs = pictureRuns(node.children);
	if (runs.length === 0) {
		return [node];
	}
	const pieces: Element[] = [];
	let from = 0;
	for (const [start, end] of runs) {
		const before = node.children.slice(from, start);
		if (!before.every(isBlank)) {
			pieces.push(paragraph(before));
		}
		pieces.push(paragraph(node.children.slice(start, end + 1)));
		from = end + 1;
	}
	const after = node.children.slice(from);
	if (!after.every(isBlank)) {
		pieces.push(paragraph(after));
	}
	return pieces;
}

// Takes the answer's pictures out of its words, each run of them that stands one after another,
// in a paragraph or in paragraphs of their own, onto a row of its own.
function gatherPictures() {
	return (tree: Root) => {
		const children: RootContent[] = [];
		let run: Element[] = [];
		let between: RootContent[] = [];
		for (const node of tree.children.flatMap(splitPictures)) {
			if (isPictures(node)) {
				run.push(node);
				between = [];
				continue;
			}
			if (run.length > 0 && isBlank(node)) {
				between.push(node);
				continue;
			}
			children.push(...gallery(run), ...between, node);
			run = [];
			between = [];
		}
		children.push(...gallery(run), ...between);
		tree.children = children;
	};
}

// A row of pictures: side by side, wrapping onto the next row where the line is full.
function Pictures({children}: {children: ReactNode}) {
	return <div className="flex flex-wrap gap-1.5 py-1">{children}</div>;
}

const LINK_CLASS = 'underline underline-offset-4 hover:text-foreground';

// A path in the app, as the conversation's own word on connecting Claude links the Account page:
// that page kept to the organization the link was followed from.
function AppLink({
	path,
	className,
	children,
}: {
	path: string;
	className?: string;
	children: ReactNode;
}) {
	const org = useOrgSlug();
	return (
		<Link className={cn(LINK_CLASS, className)} to={path === '/account' ? accountPath(org) : path}>
			{children}
		</Link>
	);
}

const MarkdownLink: NonNullable<Components['a']> = ({
	node: _node,
	className,
	href,
	children,
	...props
}) => {
	const hosts = useContext(FaviconHostsContext);
	if (href?.startsWith('/') && !href.startsWith('//')) {
		return (
			<AppLink path={href} className={className}>
				{children}
			</AppLink>
		);
	}
	const host = hosts ? faviconHost(href, hosts) : null;
	const content = (
		<>
			{host && (
				<img
					src={`/api/favicons/${encodeURIComponent(host)}`}
					alt=""
					loading="lazy"
					className="inline-block h-3.5 w-[18px] rounded-[3px] pr-1 align-[-2px] object-contain"
					onError={(event) => {
						event.currentTarget.hidden = true;
					}}
				/>
			)}
			{children}
		</>
	);
	// Where the link has a favicon it is an https address that the cards are made for.
	if (host && href) {
		return (
			<LinkPreviewCard className={cn(LINK_CLASS, className)} href={href} {...props}>
				{content}
			</LinkPreviewCard>
		);
	}
	return (
		<a className={cn(LINK_CLASS, className)} href={href} target="_blank" rel="noreferrer" {...props}>
			{content}
		</a>
	);
};

// A picture as `image` shows it, or as a link to it, saying what it shows.
const MarkdownImage: NonNullable<Components['img']> = ({src, alt}) => {
	const image = useContext(ImageContext);
	const href = typeof src === 'string' ? src : '';
	const said = alt ?? '';
	const shown = href === '' || image === null ? null : image(href, said);
	if (shown !== null) {
		return shown;
	}
	if (href === '') {
		return said;
	}
	return (
		<a className={LINK_CLASS} href={href} target="_blank" rel="noreferrer">
			<ImageIcon className="inline-block h-3.5 w-[18px] pr-1 align-[-2px]" />
			{said === '' ? href : said}
		</a>
	);
};

const components: Components = {
	a: MarkdownLink,
	img: MarkdownImage,
	p: ({node, className, children, ...props}) => {
		if (node?.properties.dataPictures === true) {
			return <Pictures>{children}</Pictures>;
		}
		return (
			<p className={cn('leading-relaxed', className)} {...props}>
				{children}
			</p>
		);
	},
	ul: ({node: _node, className, ...props}) => (
		<ul className={cn('flex list-disc flex-col gap-1 pl-5', className)} {...props} />
	),
	ol: ({node: _node, className, ...props}) => (
		<ol className={cn('flex list-decimal flex-col gap-1 pl-5', className)} {...props} />
	),
	h1: ({node: _node, className, ...props}) => (
		<p className={cn('font-semibold', className)} {...props} />
	),
	h2: ({node: _node, className, ...props}) => (
		<p className={cn('font-semibold', className)} {...props} />
	),
	h3: ({node: _node, className, ...props}) => (
		<p className={cn('font-semibold', className)} {...props} />
	),
	h4: ({node: _node, className, ...props}) => (
		<p className={cn('font-semibold', className)} {...props} />
	),
	h5: ({node: _node, className, ...props}) => (
		<p className={cn('font-semibold', className)} {...props} />
	),
	h6: ({node: _node, className, ...props}) => (
		<p className={cn('font-semibold', className)} {...props} />
	),
	blockquote: ({node: _node, className, ...props}) => (
		<blockquote className={cn('border-l-2 pl-3 text-muted-foreground', className)} {...props} />
	),
	hr: ({node: _node, className, ...props}) => (
		<hr className={cn('border-border', className)} {...props} />
	),
	pre: ({node: _node, className, ...props}) => (
		<pre
			className={cn(
				'overflow-x-auto rounded-md bg-muted px-3 py-3.5 font-mono [text-box:trim-both_cap_alphabetic] text-xs leading-relaxed',
				className,
			)}
			{...props}
		/>
	),
	code: ({node: _node, className, ...props}) => (
		<code
			className={cn('rounded bg-muted px-1 py-0.5 font-mono text-xs in-[pre]:p-0', className)}
			{...props}
		/>
	),
	table: ({node: _node, className, ...props}) => (
		<div className="overflow-x-auto rounded-md border">
			<table className={cn('w-full border-collapse text-left', className)} {...props} />
		</div>
	),
	th: ({node: _node, className, ...props}) => (
		<th
			className={cn(
				'border-r border-b bg-muted px-3 py-1.5 font-semibold last:border-r-0',
				className,
			)}
			{...props}
		/>
	),
	td: ({node: _node, className, ...props}) => (
		<td
			className={cn(
				'border-r border-b px-3 py-1.5 align-top last:border-r-0 in-[tr:last-child]:border-b-0',
				className,
			)}
			{...props}
		/>
	),
};

const componentsWithoutImages: Components = {
	...components,
	img: ({node: _node, alt}) => (alt ? <span>{alt}</span> : null),
};

function faviconHost(href: string | undefined, hosts: Set<string>): string | null {
	if (!href || !/^https:\/\//i.test(href) || !URL.canParse(href)) {
		return null;
	}
	const url = new URL(href);
	if (url.protocol !== 'https:') {
		return null;
	}
	if (hosts.has(url.hostname)) {
		return url.hostname;
	}
	if (hosts.size >= MAX_FAVICON_HOSTS) {
		return null;
	}
	hosts.add(url.hostname);
	return url.hostname;
}

// What each text was drawn as, the last few hundred: parsing is most of what drawing Markdown
// costs, and a chat draws the same answers again as it is opened again or a turn moves in it. The
// tree is a description, the same wherever it is drawn: its links read the favicons and the
// organization, and its pictures the page's `image`, where they are drawn.
const MAX_PARSED = 300;
const parsed = new Map<string, ReactElement>();

function parse(text: string, allowImages: boolean): ReactElement {
	const key = `${allowImages ? 'images' : 'no-images'}:${text}`;
	const known = parsed.get(key);
	if (known !== undefined) {
		parsed.delete(key);
		parsed.set(key, known);
		return known;
	}
	const tree = ReactMarkdown({
		children: text,
		remarkPlugins: [remarkGfm],
		rehypePlugins: [gatherPictures],
		components: allowImages ? components : componentsWithoutImages,
	});
	parsed.set(key, tree);
	const oldest = parsed.keys().next().value;
	if (parsed.size > MAX_PARSED && oldest !== undefined) {
		parsed.delete(oldest);
	}
	return tree;
}

export function Markdown({
	text,
	className,
	image = null,
	allowImages = true,
	showFavicons = true,
}: {
	text: string;
	className?: string;
	image?: ImageOf | null;
	allowImages?: boolean;
	showFavicons?: boolean;
}) {
	const [faviconHosts] = useState(() => new Set<string>());
	const tree = useMemo(() => parse(text, allowImages), [text, allowImages]);
	return (
		<FaviconHostsContext.Provider value={showFavicons ? faviconHosts : null}>
			<ImageContext.Provider value={image}>
				<div className={cn('flex flex-col gap-2 wrap-break-word', className)}>{tree}</div>
			</ImageContext.Provider>
		</FaviconHostsContext.Provider>
	);
}
