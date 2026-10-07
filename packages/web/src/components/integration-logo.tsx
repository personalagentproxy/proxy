import {BrandLogo} from '@/components/brand-logo';
import type {Integration} from '@/lib/types';

export function IntegrationLogo({
	integration,
	className,
}: {
	integration: Integration;
	className?: string;
}) {
	const FallbackIcon = integration.icon;

	return (
		<BrandLogo
			src={integration.logoUrl}
			fallback={<FallbackIcon className="size-[60%] text-muted-foreground" />}
			className={className}
		/>
	);
}
