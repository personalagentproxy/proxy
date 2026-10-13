import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import {defineConfig} from 'vite';

export default defineConfig({
	plugins: [react(), tailwindcss()],
	// What the crawl writes: map.json and the screenshots, served as they are.
	publicDir: 'generated',
	server: {port: 5176, strictPort: true},
});
