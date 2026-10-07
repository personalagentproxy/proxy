import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import {defineConfig, loadEnv} from 'vite';

export default defineConfig(({mode}) => {
	// The api's port, from the root .env it shares with the api.
	const {PORT} = loadEnv(mode, path.resolve(import.meta.dirname, '../..'), '');
	const api = `http://localhost:${PORT || 4000}`;

	return {
		plugins: [react(), tailwindcss()],
		resolve: {
			alias: {
				'@': path.resolve(import.meta.dirname, './src'),
			},
		},
		// The api's paths go to the api, so in development the browser sees one origin, as it does
		// in production, where the api serves the built app itself.
		server: {
			proxy: {'/api/': api, '/auth/': api, '/agent-auth/': api},
		},
	};
});
