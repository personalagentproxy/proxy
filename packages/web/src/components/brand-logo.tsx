import {findAgentProvider} from '@proxy/integrations';
import {BotIcon} from 'lucide-react';
import {cn} from '@proxy/ui/lib/utils';
import type {ReactNode} from 'react';
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

// A custom agent has no logo of its own, so it gets a robot.
export function AgentLogo({providerId}: {providerId: string}) {
	const provider = findAgentProvider(providerId);
	if (provider?.custom) {
		return (
			<LogoTile>
				<BotIcon className="size-[60%] text-neutral-500" />
			</LogoTile>
		);
	}

	return (
		<LogoTile>
			{provider?.faviconUrl && (
				<img src={provider.faviconUrl} alt="" className="size-full object-contain p-[2px]" />
			)}
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
	if ('src' in integration.logo) {
		return (
			<LogoTile className={className}>
				<img
					src={integration.logo.src}
					alt=""
					className={cn(
						'size-full',
						integration.logo.fill ? 'object-cover' : 'object-contain p-[2px]',
					)}
				/>
			</LogoTile>
		);
	}

	return (
		<LogoTile className={className}>
			<integration.logo className="size-[60%] text-neutral-500" />
		</LogoTile>
	);
}
