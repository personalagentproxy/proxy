import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import {RouterProvider} from 'react-router';
import './index.css';
import {TooltipProvider} from '@proxy/ui/components/tooltip';
import {router} from '@/router';
import {hasHiddenDesktopTitleBar} from '@/lib/desktop';
import {ThemeProvider} from '@proxy/ui/components/theme-provider';

const root = document.getElementById('root');

if (!root) {
	throw new Error('Missing #root element');
}

if (hasHiddenDesktopTitleBar()) {
	document.documentElement.classList.add('desktop-app');
}

createRoot(root).render(
	<StrictMode>
		<ThemeProvider>
			<TooltipProvider>
				<RouterProvider router={router} />
			</TooltipProvider>
		</ThemeProvider>
	</StrictMode>,
);
