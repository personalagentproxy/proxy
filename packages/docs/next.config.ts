import type {NextConfig} from 'next';

const nextConfig: NextConfig = {
	// @proxy/ui ships its TypeScript source.
	transpilePackages: ['@proxy/ui'],
};

export default nextConfig;
