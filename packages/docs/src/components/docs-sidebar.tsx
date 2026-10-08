'use client';

import Link from 'next/link';
import {usePathname} from 'next/navigation';
import {useState} from 'react';
import {ChevronRightIcon} from 'lucide-react';
import {cn} from '@proxy/ui/lib/utils';
import {
	Sidebar,
	SidebarContent,
	SidebarGroup,
	SidebarGroupLabel,
	SidebarHeader,
	SidebarMenu,
	SidebarMenuAction,
	SidebarMenuButton,
	SidebarMenuItem,
	SidebarMenuSub,
	SidebarMenuSubButton,
	SidebarMenuSubItem,
	useSidebar,
} from '@proxy/ui/components/sidebar';
import type {NavItem, NavSection} from '@/lib/docs';

// The app's shadcn sidebar, expanded with labels: on desktop beside the page (⌘B hides it), on
// phones a sheet from the left that closes again on every pick. Labels and rows leave room on the
// left for the chevrons of rows with nested pages.
export function DocsSidebar({sections}: {sections: NavSection[]}) {
	const pathname = usePathname();
	const {setOpenMobile} = useSidebar();
	// The page last picked here, so the sidebar shows it as current on the click instead of once its
	// content has loaded. Forgotten as soon as the path changes, to it or anywhere else.
	const [picked, setPicked] = useState<string | null>(null);
	const [seenPathname, setSeenPathname] = useState(pathname);
	if (seenPathname !== pathname) {
		setSeenPathname(pathname);
		setPicked(null);
	}
	const current = picked ?? pathname;

	const navigate = (href: string) => {
		setPicked(href);
		setOpenMobile(false);
	};

	return (
		<Sidebar>
			<SidebarHeader className="h-12 justify-center border-b pr-4 pl-6">
				<Link href="/" className="text-sm font-medium" onNavigate={() => navigate('/')}>
					Personal Agent Proxy <span className="text-muted-foreground">Docs</span>
				</Link>
			</SidebarHeader>
			<SidebarContent>
				{sections.map((section) => (
					<SidebarGroup key={section.title}>
						<SidebarGroupLabel className="pl-4">{section.title}</SidebarGroupLabel>
						<SidebarMenu>
							{section.items.map((item) => (
								<DocsSidebarItem
									key={item.href}
									item={item}
									current={current}
									navigate={navigate}
								/>
							))}
						</SidebarMenu>
					</SidebarGroup>
				))}
			</SidebarContent>
		</Sidebar>
	);
}

// A row and the pages nested under it. They fold out with the item's `open`, else while it or one
// of them is the current page, until the chevron folds them in or out by hand; that choice holds
// until the page reloads.
function DocsSidebarItem({
	item,
	current,
	navigate,
}: {
	item: NavItem;
	current: string;
	navigate: (href: string) => void;
}) {
	const [chosen, setChosen] = useState<boolean | null>(null);

	const inside = current === item.href || item.pages.some((page) => page.href === current);
	const expanded = chosen ?? (item.open || inside);

	return (
		<SidebarMenuItem>
			<SidebarMenuButton
				isActive={current === item.href}
				className="pl-4 group-has-data-[sidebar=menu-action]/menu-item:pr-2"
				render={<Link href={item.href} onNavigate={() => navigate(item.href)} />}
			>
				<span>{item.title}</span>
			</SidebarMenuButton>
			{item.pages.length > 0 && (
				<SidebarMenuAction
					aria-label={expanded ? `Fold in ${item.title}` : `Fold out ${item.title}`}
					aria-expanded={expanded}
					className="right-auto -left-0.5 w-4 text-muted-foreground peer-data-[size=default]/menu-button:top-2"
					onClick={() => setChosen(!expanded)}
				>
					<ChevronRightIcon
						className={cn('size-3.5! transition-transform', expanded && 'rotate-90')}
					/>
				</SidebarMenuAction>
			)}
			{item.pages.length > 0 && expanded && (
				<SidebarMenuSub className="mx-1.5">
					{item.pages.map((page) => (
						<SidebarMenuSubItem key={page.href}>
							<SidebarMenuSubButton
								isActive={current === page.href}
								render={<Link href={page.href} onNavigate={() => navigate(page.href)} />}
							>
								<span>{page.title}</span>
							</SidebarMenuSubButton>
						</SidebarMenuSubItem>
					))}
				</SidebarMenuSub>
			)}
		</SidebarMenuItem>
	);
}
