import * as React from 'react';
import {cn} from 'cn';

function Trace({className, ...props}: React.ComponentProps<'div'>) {
	return (
		<div
			data-slot="trace"
			className={cn(
				'flex w-full min-w-0 flex-col gap-2 *:has-[>[data-slot=trace-line]]:flex *:has-[>[data-slot=trace-line]]:w-fit *:has-[>[data-slot=trace-line]]:max-w-full *:has-[>[data-slot=trace-line]]:min-w-0 *:has-[>[data-slot=trace-line]]:rounded-md *:has-[>[data-slot=trace-line]]:text-left *:has-[>[data-slot=trace-line]]:outline-none *:has-[>[data-slot=trace-line]]:focus-visible:ring-3 *:has-[>[data-slot=trace-line]]:focus-visible:ring-ring/50',
				className,
			)}
			{...props}
		/>
	);
}

function TraceLine({
	className,
	status,
	...props
}: React.ComponentProps<'span'> & {
	status?: 'running' | 'error' | 'pending';
}) {
	return (
		<span
			data-slot="trace-line"
			data-status={status}
			className={cn(
				'flex w-fit max-w-full min-w-0 items-center gap-2 text-sm text-muted-foreground transition-colors in-[a,button]:cursor-pointer in-[a:hover,button:hover]:text-foreground data-[status=error]:text-destructive data-[status=error]:in-[a:hover,button:hover]:text-destructive data-[status=pending]:opacity-60 data-[status=running]:*:data-[slot=trace-title]:shimmer',
				className,
			)}
			{...props}
		/>
	);
}

function TraceIcon({className, ...props}: React.ComponentProps<'span'>) {
	return (
		<span
			data-slot="trace-icon"
			aria-hidden="true"
			className={cn(
				"flex size-4 shrink-0 items-center justify-center [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 [[data-slot=trace-title]~&]:-ml-1",
				className,
			)}
			{...props}
		/>
	);
}

function TraceTitle({className, ...props}: React.ComponentProps<'span'>) {
	return (
		<span
			data-slot="trace-title"
			className={cn('min-w-0 truncate motion-reduce:shimmer-none', className)}
			{...props}
		/>
	);
}

export {Trace, TraceLine, TraceIcon, TraceTitle};
