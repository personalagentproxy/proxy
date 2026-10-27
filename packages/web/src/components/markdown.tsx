import ReactMarkdown, {type Components} from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {cn} from '@proxy/ui/lib/utils';

// What a persona answers, as Markdown: paragraphs, lists, tables, code and links, styled to sit
// in a chat bubble. Every link opens in a new tab, since the conversation stays here. Each
// component takes the element's own props, without the syntax tree node react-markdown hands
// along, which is no attribute of an element.

const components: Components = {
	p: ({node: _node, className, ...props}) => (
		<p className={cn('leading-relaxed', className)} {...props} />
	),
	a: ({node: _node, className, ...props}) => (
		<a
			className={cn('underline underline-offset-4 hover:text-foreground', className)}
			target="_blank"
			rel="noreferrer"
			{...props}
		/>
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
				'overflow-x-auto rounded-md bg-muted px-3 py-2 font-mono text-xs leading-relaxed',
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

export function Markdown({text, className}: {text: string; className?: string}) {
	return (
		<div className={cn('flex flex-col gap-2 wrap-break-word', className)}>
			<ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
				{text}
			</ReactMarkdown>
		</div>
	);
}
