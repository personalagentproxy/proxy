import type {ReactNode} from 'react';

// A setup step's title, and what it is for beneath it.
export function StepHeading({title, children}: {title: string; children?: ReactNode}) {
	return (
		<div className="grid gap-1">
			<h1 className="font-medium">{title}</h1>
			{children && <p className="text-sm text-muted-foreground">{children}</p>}
		</div>
	);
}
