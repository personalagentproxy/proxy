import {PanelLeftIcon} from 'lucide-react';
import {type ReactNode, useState} from 'react';
import {useLocation} from 'react-router';
import {AppSidebar} from '@/components/nav';
import {Button} from '@proxy/ui/components/button';
import {Sheet, SheetContent, SheetTitle} from '@proxy/ui/components/sheet';
import {SidebarTrigger} from '@proxy/ui/components/sidebar';
import {useDesktop} from '@proxy/ui/hooks/use-media-query';
import {cn} from '@proxy/ui/lib/utils';

type Props = {
	children: ReactNode;
	// The header's title; a page without one, as Home, has no header, and on a phone the sidebar's
	// button alone in its corner.
	title?: ReactNode;
	actions?: ReactNode;
	// A second sidebar beside the first, as Chat's conversations: a column on desktop, and on a
	// phone a sheet opened from the header, named by `panelLabel`.
	panel?: ReactNode;
	panelLabel?: string;
	// `inside`: the page is as tall as the window and scrolls a part of itself, as Chat scrolls its
	// log, so the header, the sidebars and the rest stay put, the overscroll bounce included.
	// Otherwise the whole page scrolls.
	scroll?: 'page' | 'inside';
};

// The second sidebar on a phone: a sheet from the left. It is keyed by the path, so a move
// elsewhere closes it.
function PanelSheet({panel, label}: {panel: ReactNode; label: string}) {
	const [open, setOpen] = useState(false);

	return (
		<Sheet open={open} onOpenChange={setOpen}>
			<Button variant="ghost" size="icon-sm" aria-label={label} onClick={() => setOpen(true)}>
				<PanelLeftIcon />
			</Button>
			<SheetContent
				side="left"
				showCloseButton={false}
				className="w-72 gap-0 bg-sidebar p-0 text-sidebar-foreground"
			>
				<SheetTitle className="sr-only">{label}</SheetTitle>
				{panel}
			</SheetContent>
		</Sheet>
	);
}

// The human side's frame: the sidebar, a header with the page's title and actions, and the page
// in one centered column.
export function AppShell({
	children,
	title,
	actions,
	panel,
	panelLabel = 'Panel',
	scroll = 'page',
}: Props) {
	const desktop = useDesktop();
	const {pathname} = useLocation();

	return (
		<>
			<AppSidebar />
			{panel !== undefined && desktop && (
				<aside className="sticky top-0 flex h-dvh w-64 shrink-0 flex-col border-r bg-sidebar text-sidebar-foreground">
					{panel}
				</aside>
			)}
			<div
				className={cn(
					'relative flex w-full min-w-0 flex-1 flex-col bg-background text-foreground',
					scroll === 'inside' ? 'h-dvh overflow-hidden' : 'min-h-dvh',
				)}
			>
				{title !== undefined && (
					<header className="sticky top-0 z-20 flex h-12 items-center justify-between gap-4 border-b bg-background px-4">
						<div className="flex min-w-0 flex-1 items-center gap-2">
							{!desktop && <SidebarTrigger />}
							{!desktop && panel !== undefined && (
								<PanelSheet key={pathname} panel={panel} label={panelLabel} />
							)}
							{title}
						</div>
						{actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
					</header>
				)}
				{title === undefined && !desktop && (
					<div className="absolute top-2 left-4 z-20">
						<SidebarTrigger />
					</div>
				)}
				<main
					className={cn(
						'flex w-full flex-1 flex-col',
						// Scrolling inside, the page lays out its own column, so its scroller can
						// reach the window's edge.
						scroll === 'inside' ? 'min-h-0' : 'page-column mx-auto max-w-3xl gap-4 pt-6 pb-12',
					)}
				>
					{children}
				</main>
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
