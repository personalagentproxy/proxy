import type {NextConfig} from 'next';

const nextConfig: NextConfig = {
	// Plain files in out/, for any static host, like the docs (packages/docs/next.config.ts).
	output: 'export',
	trailingSlash: true,
	// @proxy/ui ships its TypeScript source.
	transpilePackages: ['@proxy/ui'],
};

export default nextConfig;
