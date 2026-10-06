import type {ReactNode} from 'react';
import {Link} from 'react-router';

// The compact list every page shares: one line per row, the whole row a link or a button.
// Callers pass their own trailing cells, with widths and phone/desktop visibility set by class,
// and the header above the rows carries the same classes, which keeps the columns lined up.
export function RowList({header, children}: {header?: ReactNode; children: ReactNode}) {
	return (
		<div className="-mx-4 md:mx-0">
			{header}
			<ul>{children}</ul>
		</div>
	);
}

type RowProps = {
	icon?: ReactNode;
	title: ReactNode;
	// Cells after the title, right-aligned in the order given.
	cells?: ReactNode;
} & ({to: string; onClick?: never} | {onClick: () => void; to?: never});

const ROW =
	'flex h-10 w-full items-center gap-3 px-4 text-left text-sm hover:bg-muted/50 active:bg-muted/50 md:px-3';

export function Row({to, onClick, icon, title, cells}: RowProps) {
	const content = (
		<>
			{icon}
			<span className="min-w-0 flex-1 truncate">{title}</span>
			{cells}
		</>
	);

	if (to !== undefined) {
		return (
			<li>
				<Link to={to} className={ROW}>
					{content}
				</Link>
			</li>
		);
	}

	return (
		<li>
			<button type="button" onClick={onClick} className={ROW}>
				{content}
			</button>
		</li>
	);
}

// The column labels above the rows, laid out by the caller with the rows' own cell classes.
export function RowHeader({children}: {children: ReactNode}) {
	return (
		<div className="flex h-8 items-center gap-3 px-4 text-xs text-muted-foreground md:px-3">
			{children}
		</div>
	);
}

// What a list says in place of its rows when it has none, indented like a row's text.
export function EmptyRows({children}: {children: ReactNode}) {
	return <li className="px-4 py-3 text-sm text-muted-foreground md:px-3">{children}</li>;
}
