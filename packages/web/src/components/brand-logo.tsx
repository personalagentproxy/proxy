import {findAgentProvider, BUILT_IN_AGENT_PROVIDER} from '@proxy/utils/agent-providers';
import {DEFAULT_LOOK} from '@proxy/utils/harness';
import {cn} from '@proxy/ui/lib/utils';
import {useState, type ReactNode} from 'react';
import {Head} from '@/components/head';
import type {Integration} from '@/lib/integrations';

// Our mark, drawn in ink: a custom agent's, a custom MCP server's without an icon of its own, and
// what Personal Agent Proxy did itself.
const MARK = '/favicon.svg';

// Logos sit inset on a quiet tile, the page's muted surface, without a border or shadow, so a
// list of them reads as one set. They're decorative: the text beside one always names it.
function LogoTile({children, className}: {children: ReactNode; className?: string}) {
	return (
		<span
			aria-hidden
			className={cn(
				'flex size-5 shrink-0 items-center justify-center overflow-hidden rounded-[30%] bg-muted',
				className,
			)}
		>
			{children}
		</span>
	);
}

// A logo in one dark color, as ours and Notion's are: white on a dark page, so it shows on the tile.
function InkMark({src, onError}: {src: string; onError?: () => void}) {
	return (
		<img src={src} alt="" onError={onError} className="size-[64%] object-contain dark:invert" />
	);
}

/**
 * An external agent's logo: its app icon, inset on the tile; ours for a custom MCP agent, which is
 * connected through Personal Agent Proxy. The built-in agent, which the Chat page's personas act
 * through, is a persona's head, in the page's ink.
 */
export function AgentLogo({providerId, className}: {providerId: string; className?: string}) {
	if (providerId === BUILT_IN_AGENT_PROVIDER.id) {
		return <Head look={DEFAULT_LOOK} color="mono" size={20} className={className} />;
	}
	const provider = findAgentProvider(providerId);
	if (provider?.custom) {
		return (
			<LogoTile className={className}>
				<InkMark src={MARK} />
			</LogoTile>
		);
	}

	return (
		<LogoTile className={className}>
			{provider?.faviconUrl && (
				<span className="size-[72%] overflow-hidden rounded-[28%]">
					<img src={provider.faviconUrl} alt="" className="size-full object-cover" />
				</span>
			)}
		</LogoTile>
	);
}

// Personal Agent Proxy's own mark, for what it did itself in the activity log.
export function ProxyLogo() {
	return (
		<LogoTile>
			<InkMark src={MARK} />
		</LogoTile>
	);
}

/**
 * A connection's logo: our icon for what is no one brand's (the vault, the sandboxes, a mailbox),
 * in the page's ink, or the brand's mark, inset on the tile.
 */
export function IntegrationLogo({
	integration,
	className,
}: {
	integration: Integration;
	className?: string;
}) {
	const [failed, setFailed] = useState<string | null>(null);
	if ('src' in integration.logo) {
		const {src, fallback, ink} = integration.logo;
		// A logo found on the internet that doesn't load, or that the api found none of, is our mark.
		if (failed === src && fallback) {
			return (
				<LogoTile className={className}>
					<InkMark src={fallback} />
				</LogoTile>
			);
		}
		if (ink) {
			return (
				<LogoTile className={className}>
					<InkMark src={src} onError={() => setFailed(src)} />
				</LogoTile>
			);
		}
		return (
			<LogoTile className={className}>
				<img
					src={src}
					alt=""
					onError={() => setFailed(src)}
					className="size-[64%] object-contain"
				/>
			</LogoTile>
		);
	}

	return (
		<LogoTile className={className}>
			<integration.logo data-preserve-color className="size-[58%] text-foreground" />
		</LogoTile>
	);
}
