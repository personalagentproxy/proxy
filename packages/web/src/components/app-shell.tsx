import type {ReactNode} from 'react';
import {AppSidebar} from '@/components/nav';
import {SidebarTrigger} from '@proxy/ui/components/sidebar';
import {useDesktop} from '@proxy/ui/hooks/use-media-query';

type Props = {
	children: ReactNode;
	title: ReactNode;
	actions?: ReactNode;
};

// The human side's frame: the sidebar, a header with the page's title and actions, and the page
// in one centered column.
export function AppShell({children, title, actions}: Props) {
	const desktop = useDesktop();

	return (
		<>
			<AppSidebar />
			<div className="relative flex min-h-dvh w-full min-w-0 flex-1 flex-col bg-background text-foreground">
				<header className="sticky top-0 z-20 flex h-12 items-center justify-between gap-4 border-b bg-background px-4">
					<div className="flex min-w-0 flex-1 items-center gap-2">
						{!desktop && <SidebarTrigger />}
						{title}
					</div>
					{actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
				</header>
				<main className="mx-auto w-full max-w-3xl px-4 pt-6 pb-12">{children}</main>
			</div>
		</>
	);
}

// The header's title: the page's name, with an optional muted detail beside it.
export function PageTitle({children, detail}: {children: ReactNode; detail?: ReactNode}) {
	return (
		<>
			<span className="truncate text-sm font-medium">{children}</span>
			{detail !== undefined && (
				<span className="hidden truncate text-sm text-muted-foreground tabular-nums md:inline">
					{detail}
				</span>
			)}
		</>
	);
}
