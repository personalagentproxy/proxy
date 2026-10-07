import type {MDXComponents} from 'mdx/types';
import Link from 'next/link';
import type {ComponentProps} from 'react';
import {cn} from '@proxy/ui/lib/utils';
import {Callout} from '@/components/callout';
import {CodeBlock} from '@/components/code-block';
import {EnvTable} from '@/components/env-table';
import {Steps} from '@/components/steps';

// A heading that links to itself, so a section can be shared. rehype-slug gives it its id.
function heading(Tag: 'h2' | 'h3', className: string) {
	return function Heading({id, children, ...props}: ComponentProps<'h2'>) {
		return (
			<Tag id={id} className={cn('scroll-mt-16', className)} {...props}>
				<a href={`#${id}`}>{children}</a>
			</Tag>
		);
	};
}

// Pages link to each other by path; anything with a scheme opens in a new tab.
function Anchor({href = '', className, ...props}: ComponentProps<'a'>) {
	const classes = cn('font-medium underline underline-offset-4', className);

	if (href.startsWith('/') || href.startsWith('#')) {
		return <Link href={href} className={classes} {...props} />;
	}
	return <a href={href} target="_blank" rel="noreferrer" className={classes} {...props} />;
}

// Every element a page's Markdown can produce, styled like the app, and the components pages can
// use without importing them.
export const mdxComponents: MDXComponents = {
	h2: heading('h2', 'mt-10 mb-3 text-lg font-semibold tracking-tight'),
	h3: heading('h3', 'mt-8 mb-2 text-base font-semibold'),
	p: (props) => <p className="my-4 leading-7" {...props} />,
	a: Anchor,
	ul: (props) => <ul className="my-4 ml-5 list-disc space-y-1.5 leading-7" {...props} />,
	ol: (props) => <ol className="my-4 ml-5 list-decimal space-y-1.5 leading-7" {...props} />,
	strong: (props) => <strong className="font-semibold" {...props} />,
	hr: (props) => <hr className="my-10" {...props} />,
	blockquote: (props) => (
		<blockquote className="my-5 border-l-2 pl-4 text-muted-foreground" {...props} />
	),
	// Inline code. Code blocks are a `pre` around a `code`, which globals.css resets.
	code: (props) => (
		<code className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-[0.8125rem]" {...props} />
	),
	pre: CodeBlock,
	table: (props) => (
		<div className="my-5 overflow-x-auto">
			<table className="w-full text-left text-sm" {...props} />
		</div>
	),
	th: (props) => <th className="border-b px-3 py-2 font-medium first:pl-0" {...props} />,
	td: (props) => <td className="border-b px-3 py-2 align-top first:pl-0" {...props} />,
	Callout,
	EnvTable,
	Steps,
};
