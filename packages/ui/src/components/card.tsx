import type {ComponentProps} from 'react';
import {cn} from 'cn';

// A bordered box on the page. Its padding is where text starts inside it, and a row in it reaches
// within a little of its border (`bleed`), clear of its rounded corners.
function Card({className, ...props}: ComponentProps<'div'>) {
	return (
		<div
			data-slot="card"
			className={cn('rounded-xl border bg-card p-4 [--bleed:--spacing(3)]', className)}
			{...props}
		/>
	);
}

export {Card};
