import {Link} from 'react-router';
import {PillTab} from '@proxy/ui/components/pill-tab';
import type {PageTab} from '@/lib/page-tabs';

// A page's parts as tabs under its title, one shown at a time (lib/page-tabs.ts): each a link, so
// a part has an address of its own (`?tab=<id>`, the first part's being the page's), drawn as the
// lists' own toggles are, the one shown filled in and the others their labels alone. With
// `toolbar`, the row has room on its right for the shown part's own buttons, which it puts there
// (a portal into the element given back), as the Files put their search and upload.
export function PageTabs<T extends string>({
	tabs,
	chosen,
	label,
	toolbar,
}: {
	tabs: Array<PageTab<T>>;
	chosen: T | null;
	// What the tabs are of, for a screen reader: "Connection".
	label: string;
	toolbar?: (element: HTMLElement | null) => void;
}) {
	if (!toolbar) {
		return <Tabs tabs={tabs} chosen={chosen} label={label} />;
	}
	return (
		<div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
			<Tabs tabs={tabs} chosen={chosen} label={label} />
			<div ref={toolbar} className="ml-auto flex items-center empty:hidden" />
		</div>
	);
}

function Tabs<T extends string>({
	tabs,
	chosen,
	label,
}: {
	tabs: Array<PageTab<T>>;
	chosen: T | null;
	label: string;
}) {
	return (
		<nav aria-label={`${label} sections`} className="flex flex-wrap gap-1">
			{tabs.map((tab, index) => (
				<PillTab
					key={tab.id}
					chosen={tab.id === chosen}
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
				</PillTab>
			))}
		</nav>
	);
}
