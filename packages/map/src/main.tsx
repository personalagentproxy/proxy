import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import './index.css';
import {MapPage} from './map-page';

const root = document.getElementById('root');

if (!root) {
	throw new Error('Missing #root element');
}

createRoot(root).render(
	<StrictMode>
		<MapPage />
	</StrictMode>,
);
