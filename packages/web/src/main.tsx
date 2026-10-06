import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import {BrowserRouter} from 'react-router';
import './index.css';
import {App} from './app.tsx';
import {MockStoreProvider} from '@/components/mock-store';

const root = document.getElementById('root');

if (!root) {
	throw new Error('Missing #root element');
}

createRoot(root).render(
	<StrictMode>
		<BrowserRouter>
			<MockStoreProvider>
				<App />
			</MockStoreProvider>
		</BrowserRouter>
	</StrictMode>,
);
