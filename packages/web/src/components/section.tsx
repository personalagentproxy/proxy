import type {ReactNode} from 'react';

type Props = {
	title: ReactNode;
	detail?: ReactNode;
	action?: ReactNode;
	children: ReactNode;
};

// A titled part of a page. The heading is indented like a row's text, so it lines up with the
// list beneath it. A flex column rather than a grid: a grid's column would grow to its widest
// truncated row on a phone instead of letting the row truncate.
export function Section({title, detail, action, children}: Props) {
	return (
		<section className="flex flex-col gap-2">
			<div className="flex min-h-8 items-center justify-between gap-4 md:px-3">
				<h2 className="text-sm font-medium">
					{title}
					{detail !== undefined && (
						<span className="font-normal text-muted-foreground"> · {detail}</span>
					)}
				</h2>
				{action}
			</div>
			{children}
		</section>
	);
}
