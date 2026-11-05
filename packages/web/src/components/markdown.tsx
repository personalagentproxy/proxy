import {createContext, useContext, useState} from 'react';
import ReactMarkdown, {type Components} from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {cn} from '@proxy/ui/lib/utils';

const MAX_FAVICON_HOSTS = 8;
const FaviconHostsContext = createContext<Set<string> | null>(null);

// What a persona answers, as Markdown: paragraphs, lists, tables, code and links, styled to sit
// in a chat bubble. Every link opens in a new tab, since the conversation stays here. Each
// component takes the element's own props, without the syntax tree node react-markdown hands
// along, which is no attribute of an element.

const MarkdownLink: NonNullable<Components['a']> = ({
	node: _node,
	className,
	href,
	children,
	...props
}) => {
	const hosts = useContext(FaviconHostsContext);
	const host = hosts ? faviconHost(href, hosts) : null;
	return (
		<a
			className={cn('underline underline-offset-4 hover:text-foreground', className)}
			href={href}
			target="_blank"
			rel="noreferrer"
			{...props}
		>
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
		</a>
	);
};

const components: Components = {
	a: MarkdownLink,
	p: ({node: _node, className, ...props}) => (
		<p className={cn('leading-relaxed', className)} {...props} />
	),
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
				'overflow-x-auto rounded-md bg-background px-3 py-2 font-mono text-xs leading-relaxed',
				className,
			)}
			{...props}
		/>
	),
	code: ({node: _node, className, ...props}) => (
		<code
			className={cn('rounded bg-background px-1 py-0.5 font-mono text-xs in-[pre]:p-0', className)}
			{...props}
		/>
	),
	table: ({node: _node, className, ...props}) => (
		<div className="overflow-x-auto">
			<table className={cn('w-full border-collapse text-left', className)} {...props} />
		</div>
	),
	th: ({node: _node, className, ...props}) => (
		<th className={cn('border-b px-2 py-1 font-medium', className)} {...props} />
	),
	td: ({node: _node, className, ...props}) => (
		<td className={cn('border-b border-border/60 px-2 py-1 align-top', className)} {...props} />
	),
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

export function Markdown({text, className}: {text: string; className?: string}) {
	const [faviconHosts] = useState(() => new Set<string>());
	return (
		<FaviconHostsContext.Provider value={faviconHosts}>
			<div className={cn('flex flex-col gap-2 wrap-break-word', className)}>
				<ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
					{text}
				</ReactMarkdown>
			</div>
		</FaviconHostsContext.Provider>
	);
}
