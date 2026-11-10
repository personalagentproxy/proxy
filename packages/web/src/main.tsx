import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import {RouterProvider} from 'react-router';
import './index.css';
import {TooltipProvider} from '@proxy/ui/components/tooltip';
import {router} from '@/router';
import {followDesktopWindowFocus, hasHiddenDesktopTitleBar} from '@/lib/desktop';
import {log, serializeError} from '@/lib/log';
import {ThemeProvider} from '@proxy/ui/components/theme-provider';

// What nothing caught: the api gets it with the page it happened on.
window.addEventListener('error', (event) => {
	log.error('uncaught error', {
		...serializeError(event.error ?? event.message),
		page: window.location.pathname,
	});
});
window.addEventListener('unhandledrejection', (event) => {
	log.error('unhandled rejection', {
		...serializeError(event.reason),
		page: window.location.pathname,
	});
});

const root = document.getElementById('root');

if (!root) {
	throw new Error('Missing #root element');
}

if (hasHiddenDesktopTitleBar()) {
	document.documentElement.classList.add('desktop-app');
	followDesktopWindowFocus();
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
