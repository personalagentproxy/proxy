import {BotIcon} from 'lucide-react';
import {BrandLogo} from '@/components/brand-logo';
import type {AgentProvider} from '@/lib/agent-providers';

export function AgentFavicon({provider, className}: {provider: AgentProvider; className?: string}) {
	return (
		<BrandLogo
			src={provider.faviconUrl}
			fallback={<BotIcon className="size-[60%] text-muted-foreground" />}
			className={className}
		/>
	);
}
