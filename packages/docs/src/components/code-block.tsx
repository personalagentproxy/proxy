'use client';

import {CheckIcon, CopyIcon} from 'lucide-react';
import {useRef, useState, type ComponentProps} from 'react';
import {Button} from '@proxy/ui/components/button';
import {cn} from '@proxy/ui/lib/utils';

// Solid, so code scrolled under the copy button does not show through it.
const BACKGROUND = 'bg-[color-mix(in_oklch,var(--muted)_50%,var(--background))]';

// A fenced code block, highlighted by Shiki at build time, with a button that copies its text.
export function CodeBlock({className, children, ...props}: ComponentProps<'pre'>) {
	const ref = useRef<HTMLPreElement>(null);
	const [copied, setCopied] = useState(false);

	return (
		<div className="relative my-5">
			<pre
				ref={ref}
				className={cn(
					'overflow-x-auto rounded-lg border py-3 pr-12 pl-4 font-mono text-[13px] leading-6',
					BACKGROUND,
					className,
				)}
				{...props}
			>
				{children}
			</pre>
			<Button
				variant="ghost"
				size="icon-sm"
				className={cn('absolute top-1.5 right-1.5 text-muted-foreground', BACKGROUND)}
				aria-label={copied ? 'Copied' : 'Copy code'}
				onClick={() => {
					void navigator.clipboard.writeText(ref.current?.textContent ?? '').then(() => {
						setCopied(true);
						setTimeout(() => setCopied(false), 1500);
					});
				}}
			>
				{copied ? <CheckIcon /> : <CopyIcon />}
			</Button>
		</div>
	);
}
