import type {NextConfig} from 'next';

const nextConfig: NextConfig = {
	// Plain files in out/, for any static host, like the docs (packages/docs/next.config.ts).
	output: 'export',
	trailingSlash: true,
};

export default nextConfig;
