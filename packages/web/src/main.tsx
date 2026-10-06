import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import {RouterProvider} from 'react-router';
import './index.css';
import {MockStoreProvider} from '@/components/mock-store';
import {TooltipProvider} from '@/components/ui/tooltip';
import {router} from '@/router';

const root = document.getElementById('root');

if (!root) {
	throw new Error('Missing #root element');
}

createRoot(root).render(
	<StrictMode>
		<MockStoreProvider>
			<TooltipProvider>
				<RouterProvider router={router} />
			</TooltipProvider>
		</MockStoreProvider>
	</StrictMode>,
);
