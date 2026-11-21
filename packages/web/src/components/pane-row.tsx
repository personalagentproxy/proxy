import type {ReactNode} from 'react';
import {cn} from '@proxy/ui/lib/utils';

/** A card of a pane beside a page: outlined, as the card that deletes something is, so each setting stands on its own. */
export const PANE_CARD = 'rounded-xl border bg-card p-4';

/**
 * A row of a pane beside a page, a card of its own: what it is, with one quiet line about it or
 * where it stands, and its one action at the right.
 */
export function PaneRow({
	title,
	line,
	action,
}: {
	title: string;
	line: ReactNode;
	action?: ReactNode;
}) {
	return (
		<section aria-label={title} className={cn('flex items-center gap-4', PANE_CARD)}>
			<div className="grid min-w-0 flex-1 gap-0.5">
				<h3 className="text-sm font-medium">{title}</h3>
				<p className="text-sm text-muted-foreground">{line}</p>
			</div>
			{action !== undefined && <div className="flex shrink-0 items-center gap-2">{action}</div>}
		</section>
	);
}
