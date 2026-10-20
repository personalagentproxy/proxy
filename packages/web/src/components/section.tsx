import type {ReactNode} from 'react';

type Props = {
	title: ReactNode;
	titleAction?: ReactNode;
	detail?: ReactNode;
	action?: ReactNode;
	children: ReactNode;
};

// A titled part of a page, its heading on the text line, as the rows of a list beneath it are. A
// flex column rather than a grid: a grid's column would grow to its widest
// truncated row on a phone instead of letting the row truncate.
export function Section({title, titleAction, detail, action, children}: Props) {
	return (
		<section className="flex flex-col gap-2">
			<div className="flex min-h-8 items-center justify-between gap-4">
				<div className="flex min-w-0 items-center gap-1">
					<h2 className="text-sm font-medium">
						{title}
						{detail !== undefined && (
							<span className="font-normal text-muted-foreground"> · {detail}</span>
						)}
					</h2>
					{titleAction}
				</div>
				{action}
			</div>
			{children}
		</section>
	);
}
