// Bundles the main process into one file, dist/main.cjs, and the window's preload into
// dist/preload.cjs, each with every dependency in it; only `electron` stays outside, since the
// runtime is it. The splash pages and their stylesheet are bundled as text.
import {build} from 'esbuild';

import pkg from './package.json';

const production = process.env.NODE_ENV === 'production';

await build({
	entryPoints: ['src/main.ts', 'src/preload.ts'],
	bundle: true,
	platform: 'node',
	format: 'cjs',
	outdir: 'dist',
	outExtension: {'.js': '.cjs'},
	external: ['electron'],
	loader: {'.html': 'text', '.css': 'text'},
	minify: production,
	sourcemap: !production,
	define: {
		'process.env.DESKTOP_VERSION': JSON.stringify(pkg.version),
		'process.env.NODE_ENV': JSON.stringify(production ? 'production' : 'development'),
	},
});
