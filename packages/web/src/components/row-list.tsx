import type {ReactNode} from 'react';
import {Link} from 'react-router';
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuTrigger,
} from '@proxy/ui/components/context-menu';
import {cn} from '@proxy/ui/lib/utils';

// The compact list every page shares: one line per row, the whole row a link or a button.
// Callers pass their own trailing cells, with widths and phone/desktop visibility set by class,
// and the header above the rows carries the same classes, which keeps the columns lined up.
export function RowList({header, children}: {header?: ReactNode; children: ReactNode}) {
	return (
		<div>
			{header}
			<ul>{children}</ul>
		</div>
	);
}

type RowProps = {
	icon?: ReactNode;
	title: ReactNode;
	// A line under the title, wrapping as long as it needs, the row growing with it.
	subtitle?: ReactNode;
	// Cells after the title, right-aligned in the order given.
	cells?: ReactNode;
	// The row's context menu, opened with a right click or a long press: its items.
	menu?: ReactNode;
	// Beside the row rather than in it, as a link elsewhere is: a link can't hold another.
	after?: ReactNode;
} & ({to: string; onClick?: never} | {onClick: () => void; to?: never});

// Its item out into the gutter of what holds the list (`--bleed`), and the row filling it, so its
// hover reaches the gutter while its text stays on the line; beside something else (`after`), the
// two share the item, the row's hover on its side only.
const ITEM = '-mx-(--bleed)';
const ROW =
	'flex w-full min-w-0 items-center gap-3 px-(--bleed) text-left text-sm hover:bg-muted/50 active:bg-muted/50';

export function Row({to, onClick, icon, title, subtitle, cells, menu, after}: RowProps) {
	const className = cn(ROW, subtitle ? 'min-h-10 py-2' : 'h-10');
	const content = (
		<>
			{icon}
			{subtitle ? (
				<span className="flex min-w-0 flex-1 flex-col gap-0.5">
					<span className="truncate">{title}</span>
					<span className="text-muted-foreground">{subtitle}</span>
				</span>
			) : (
				<span className="min-w-0 flex-1 truncate">{title}</span>
			)}
			{cells}
		</>
	);
	const link =
		to !== undefined ? (
			<Link to={to} className={className}>
				{content}
			</Link>
		) : (
			<button type="button" onClick={onClick} className={className}>
				{content}
			</button>
		);
	const control = after ? (
		<div className="flex items-center">
			{link}
			<div className="flex shrink-0 items-center pr-(--bleed)">{after}</div>
		</div>
	) : (
		link
	);

	if (!menu) {
		return <li className={ITEM}>{control}</li>;
	}

	return (
		<ContextMenu>
			<ContextMenuTrigger render={<li className={ITEM} />}>{control}</ContextMenuTrigger>
			<ContextMenuContent>{menu}</ContextMenuContent>
		</ContextMenu>
	);
}

// The column labels above the rows, laid out by the caller with the rows' own cell classes.
export function RowHeader({children}: {children: ReactNode}) {
	return (
		<div className="bleed flex h-8 items-center gap-3 text-xs text-muted-foreground">
			{children}
		</div>
	);
}

// What a list says in place of its rows when it has none, on the rows' text line.
export function EmptyRows({children}: {children: ReactNode}) {
	return <li className="py-3 text-sm text-muted-foreground">{children}</li>;
}
