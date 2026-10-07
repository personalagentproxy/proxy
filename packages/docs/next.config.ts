import type {NextConfig} from 'next';

const nextConfig: NextConfig = {
	// Both ship their TypeScript source: @proxy/ui the styling, @proxy/api the env schema the
	// environment page is built from.
	transpilePackages: ['@proxy/api', '@proxy/ui'],
};

export default nextConfig;
