import type {Metadata} from 'next';
import type {ReactNode} from 'react';
import './globals.css';

export const metadata: Metadata = {
	title: 'Personal Agent Proxy',
	description: 'Personal Agent Proxy',
};

// Follows the system theme before the first paint so the page never flashes the other one, like
// the docs and the web app's index.html.
const THEME_SCRIPT = `if (matchMedia('(prefers-color-scheme: dark)').matches) {
	document.documentElement.classList.add('dark');
}`;

export default function RootLayout({children}: {children: ReactNode}) {
	return (
		<html lang="en" suppressHydrationWarning>
			<head>
				<script dangerouslySetInnerHTML={{__html: THEME_SCRIPT}} />
			</head>
			<body>{children}</body>
		</html>
	);
}
