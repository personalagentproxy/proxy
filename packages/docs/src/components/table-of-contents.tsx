import type {Heading} from '@/lib/docs';
import {cn} from '@proxy/ui/lib/utils';

export function TableOfContents({headings}: {headings: Heading[]}) {
	if (headings.length === 0) {
		return null;
	}

	return (
		<nav className="flex flex-col gap-2 text-sm">
			<p className="font-medium">On this page</p>
			{headings.map((heading) => (
				<a
					key={heading.id}
					href={`#${heading.id}`}
					className={cn(
						'text-muted-foreground hover:text-foreground',
						heading.depth === 3 && 'pl-3',
					)}
				>
					{heading.text}
				</a>
			))}
		</nav>
	);
}
