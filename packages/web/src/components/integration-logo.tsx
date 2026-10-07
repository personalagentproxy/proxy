import {BrandLogo} from '@/components/brand-logo';
import type {Integration} from '@/lib/integrations';

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
			fallback={<FallbackIcon className="size-[60%] text-muted-foreground" />}
			className={className}
		/>
	);
}
