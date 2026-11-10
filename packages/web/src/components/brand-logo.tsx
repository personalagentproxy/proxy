import {findAgentProvider} from '@proxy/utils/agent-providers';
import {cn} from '@proxy/ui/lib/utils';
import {useState, type ReactNode} from 'react';
import type {Integration} from '@/lib/integrations';

// Logos sit on a white tile in both themes, so dark marks stay legible. They're decorative: the
// text beside one always names it.
function LogoTile({children, className}: {children: ReactNode; className?: string}) {
	return (
		<span
			aria-hidden
			className={cn(
				'flex size-5 shrink-0 items-center justify-center overflow-hidden rounded-md border bg-white shadow-xs',
				className,
			)}
		>
			{children}
		</span>
	);
}

// A custom MCP agent is connected through Personal Agent Proxy, so it gets our mark.
export function AgentLogo({providerId, className}: {providerId: string; className?: string}) {
	const provider = findAgentProvider(providerId);
	if (provider?.custom) {
		return (
			<LogoTile className={className}>
				<img src="/favicon.svg" alt="" className="size-full object-contain p-[2px]" />
			</LogoTile>
		);
	}

	return (
		<LogoTile className={className}>
			{provider?.faviconUrl && (
				<img src={provider.faviconUrl} alt="" className="size-full object-contain p-[2px]" />
			)}
		</LogoTile>
	);
}

// The marks of the harnesses an agent can run on, by the harness's id: whose service its turns go
// through.
const HARNESS_LOGOS: Record<string, string> = {
	proxy: '/harnesses/openrouter.svg',
	'claude-agent-sdk': '/agent-providers/claude.png',
};

// A harness's mark, in the model switcher; an empty tile for one that has none.
export function HarnessLogo({harnessId, className}: {harnessId: string; className?: string}) {
	const src = HARNESS_LOGOS[harnessId];
	return (
		<LogoTile className={className}>
			{src && <img src={src} alt="" className="size-full object-contain p-[2px]" />}
		</LogoTile>
	);
}

// Personal Agent Proxy's own mark, for what it did itself in the activity log.
export function ProxyLogo() {
	return (
		<LogoTile>
			<img src="/favicon.svg" alt="" className="size-full object-contain p-[2px]" />
		</LogoTile>
	);
}

export function IntegrationLogo({
	integration,
	className,
}: {
	integration: Integration;
	className?: string;
}) {
	const [failed, setFailed] = useState<string | null>(null);
	if ('src' in integration.logo) {
		const {src, fallback, fill} = integration.logo;
		// A logo found on the internet that doesn't load, or that the api found none of, is our file.
		const shown = failed === src && fallback ? fallback : src;
		return (
			<LogoTile className={className}>
				<img
					src={shown}
					alt=""
					onError={() => setFailed(src)}
					className={cn('size-full', fill ? 'object-cover' : 'object-contain p-[2px]')}
				/>
			</LogoTile>
		);
	}

	return (
		<LogoTile className={className}>
			<integration.logo data-preserve-color className="size-[60%] text-neutral-500" />
		</LogoTile>
	);
}
