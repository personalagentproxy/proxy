import type {Metadata} from 'next';
import type {ReactNode} from 'react';
import './globals.css';

export const metadata: Metadata = {
	title: 'Personal Agent Proxy',
	description: 'Personal Agent Proxy',
};

export default function RootLayout({children}: {children: ReactNode}) {
	return (
		<html lang="en" className="h-full antialiased">
			<body className="min-h-full">{children}</body>
		</html>
	);
}
