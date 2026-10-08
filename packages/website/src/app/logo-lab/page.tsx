'use client';

import dynamic from 'next/dynamic';

// Temporary exploration page for the logo. Client only: three.js has no server side.
const LogoLab = dynamic(() => import('@/components/logo-lab').then((m) => m.LogoLab), {
	ssr: false,
});

export default function LogoLabPage() {
	return <LogoLab />;
}
