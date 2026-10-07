'use client';

import Link from 'next/link';
import {usePathname} from 'next/navigation';
import {
	Sidebar,
	SidebarContent,
	SidebarGroup,
	SidebarGroupLabel,
	SidebarHeader,
	SidebarMenu,
	SidebarMenuButton,
	SidebarMenuItem,
	useSidebar,
} from '@proxy/ui/components/sidebar';
import type {NavSection} from '@/lib/docs';

// The app's shadcn sidebar, expanded with labels: on desktop beside the page (⌘B hides it), on
// phones a sheet from the left that closes again on every pick.
export function DocsSidebar({sections}: {sections: NavSection[]}) {
	const pathname = usePathname();
	const {setOpenMobile} = useSidebar();

	return (
		<Sidebar>
			<SidebarHeader className="h-12 justify-center border-b px-4">
				<Link href="/" className="text-sm font-medium" onClick={() => setOpenMobile(false)}>
					Personal Agent Proxy docs
				</Link>
			</SidebarHeader>
			<SidebarContent>
				{sections.map((section) => (
					<SidebarGroup key={section.title}>
						<SidebarGroupLabel>{section.title}</SidebarGroupLabel>
						<SidebarMenu>
							{section.pages.map((page) => (
								<SidebarMenuItem key={page.href}>
									<SidebarMenuButton
										isActive={pathname === page.href}
										render={<Link href={page.href} onClick={() => setOpenMobile(false)} />}
									>
										<span>{page.title}</span>
									</SidebarMenuButton>
								</SidebarMenuItem>
							))}
						</SidebarMenu>
					</SidebarGroup>
				))}
			</SidebarContent>
		</Sidebar>
	);
}
