import type {Metadata} from 'next';
import type {ReactNode} from 'react';
import {ThemeProvider} from '@proxy/ui/components/theme-provider';
import './globals.css';

export const metadata: Metadata = {
	title: 'Personal Agent Proxy',
	description: 'Personal Agent Proxy',
	icons: {
		icon: [
			{
				url: '/logos/personal-agent-proxy.svg',
				type: 'image/svg+xml',
				media: '(prefers-color-scheme: light)',
			},
			{
				url: '/logos/personal-agent-proxy-dark.svg',
				type: 'image/svg+xml',
				media: '(prefers-color-scheme: dark)',
			},
		],
	},
};

// Applies the saved theme, else the system's, before the first paint so the page never flashes the
// other one, like the web app's index.html. The key is the web app's, though the two origins keep
// separate storage.
const THEME_SCRIPT = `let savedTheme = null;
try {
	savedTheme = localStorage.getItem('proxy-ui-theme');
} catch {
	// Storage can be unavailable in privacy-restricted browser contexts.
}
const systemIsDark = matchMedia('(prefers-color-scheme: dark)').matches;
const isDark = savedTheme === 'dark' || (savedTheme !== 'light' && systemIsDark);
document.documentElement.classList.add(isDark ? 'dark' : 'light');`;

export default function RootLayout({children}: {children: ReactNode}) {
	return (
		<html lang="en" suppressHydrationWarning>
			<head>
				<script dangerouslySetInnerHTML={{__html: THEME_SCRIPT}} />
			</head>
			<body>
				<ThemeProvider>{children}</ThemeProvider>
			</body>
		</html>
	);
}
