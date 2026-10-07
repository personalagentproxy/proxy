import {BotIcon} from 'lucide-react';

import type {AgentProvider} from '@proxy/agent-providers';

import {BrandLogo} from '@/components/brand-logo';

export function AgentFavicon({
	provider,
	className,
}: {
	provider?: AgentProvider;
	className?: string;
}) {
	return (
		<BrandLogo
			src={provider?.faviconUrl}
			fallback={<BotIcon className="size-[60%] text-muted-foreground" />}
			className={className}
		/>
	);
}
