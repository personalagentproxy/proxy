import type {NextConfig} from 'next';

const nextConfig: NextConfig = {
	// Plain files in out/, for any static host: every page is prerendered anyway. Each page is
	// `<path>/index.html`, as hosts without clean URLs (Render's static sites) serve `/<path>/`.
	output: 'export',
	trailingSlash: true,
	// Both ship their TypeScript source: @proxy/ui the styling, @proxy/api the env schema the
	// environment page is built from.
	transpilePackages: ['@proxy/api', '@proxy/ui'],
};

export default nextConfig;
