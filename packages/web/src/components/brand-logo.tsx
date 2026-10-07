import {findAgentProvider} from '@proxy/integrations';
import {cn} from '@proxy/ui/lib/utils';
import {BotIcon, type LucideIcon} from 'lucide-react';
import type {Integration} from '@/lib/integrations';

// Logos sit on a white tile in both themes, so dark marks stay legible. They're decorative: the
// text beside one always names it.
function LogoTile({
	src,
	icon: Icon,
	className,
}: {
	src?: string;
	icon: LucideIcon;
	className?: string;
}) {
	return (
		<span
			aria-hidden
			className={cn(
				'flex size-5 shrink-0 items-center justify-center overflow-hidden rounded-md border bg-white shadow-xs',
				className,
			)}
		>
			{src ? (
				<img src={src} alt="" className="size-full object-contain p-[2px]" />
			) : (
				<Icon className="size-[60%] text-neutral-500" />
			)}
		</span>
	);
}

// A login made before each was for one agent has no provider, and shows a generic bot.
export function AgentLogo({providerId}: {providerId: string | null}) {
	return <LogoTile src={findAgentProvider(providerId)?.faviconUrl} icon={BotIcon} />;
}

export function IntegrationLogo({
	integration,
	className,
}: {
	integration: Integration;
	className?: string;
}) {
	return <LogoTile icon={integration.icon} className={className} />;
}
