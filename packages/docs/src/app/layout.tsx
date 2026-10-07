import type {Metadata} from 'next';
import type {ReactNode} from 'react';
import {SidebarProvider} from '@proxy/ui/components/sidebar';
import {TooltipProvider} from '@proxy/ui/components/tooltip';
import {DocsSidebar} from '@/components/docs-sidebar';
import {loadNav} from '@/lib/docs';
import './globals.css';

export const metadata: Metadata = {
	title: {template: '%s · Proxy docs', default: 'Proxy docs'},
};

// Follows the system theme before the first paint so the page never flashes the other one, like
// the web app's index.html.
const THEME_SCRIPT = `if (matchMedia('(prefers-color-scheme: dark)').matches) {
	document.documentElement.classList.add('dark');
}`;

export default async function RootLayout({children}: {children: ReactNode}) {
	const nav = await loadNav();
	// A page missing from src/nav.ts or bad frontmatter fails the build here.
	if (nav.isErr()) {
		throw nav.error;
	}

	return (
		<html lang="en" suppressHydrationWarning>
			<head>
				<script dangerouslySetInnerHTML={{__html: THEME_SCRIPT}} />
			</head>
			<body>
				<TooltipProvider>
					<SidebarProvider>
						<DocsSidebar sections={nav.value.sections} />
						<div className="relative flex min-h-dvh w-full min-w-0 flex-1 flex-col">{children}</div>
					</SidebarProvider>
				</TooltipProvider>
			</body>
		</html>
	);
}
