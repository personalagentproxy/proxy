import {Link} from 'react-router';
import {PillButton} from '@proxy/ui/components/pill-button';
import type {PageTab} from '@/lib/page-tabs';

// A page's parts as tabs under its title, one shown at a time (lib/page-tabs.ts): each a link, so
// a part has an address of its own (`?tab=<id>`, the first part's being the page's), drawn as the
// lists' own toggles are, the one shown filled in and the others their labels alone.
export function PageTabs<T extends string>({
	tabs,
	chosen,
	label,
}: {
	tabs: Array<PageTab<T>>;
	chosen: T | null;
	// What the tabs are of, for a screen reader: "Connection".
	label: string;
}) {
	return (
		<nav aria-label={`${label} sections`} className="flex flex-wrap gap-1">
			{tabs.map((tab, index) => (
				<PillButton
					key={tab.id}
					variant="ghost"
					nativeButton={false}
					render={
						<Link
							to={index === 0 ? '?' : `?tab=${tab.id}`}
							replace
							preventScrollReset
							aria-current={tab.id === chosen ? 'page' : undefined}
						/>
					}
				>
					{tab.label}
					{tab.count !== undefined && (
						<span className="text-muted-foreground tabular-nums">{tab.count}</span>
					)}
				</PillButton>
			))}
		</nav>
	);
}
