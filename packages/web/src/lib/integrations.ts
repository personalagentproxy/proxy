import {IdCardIcon, MailIcon, type LucideIcon} from 'lucide-react';
import {
	INTEGRATIONS as CATALOG,
	type Integration as CatalogIntegration,
	type IntegrationId,
} from '@proxy/integrations';

// A brand's own logo where it has one (in `public/integrations/`), else an icon: Information is
// ours, and Email is any mailbox. A logo that is already a square tile, as Granola's and Linear's
// are, fills the tile edge to edge.
type IntegrationLogoImage = {src: string; fill?: boolean};

export type Integration = CatalogIntegration & {logo: LucideIcon | IntegrationLogoImage};

const LOGOS: Record<IntegrationId, LucideIcon | IntegrationLogoImage> = {
	info: IdCardIcon,
	email: MailIcon,
	granola: {src: '/integrations/granola.png', fill: true},
	notion: {src: '/integrations/notion.svg'},
	linear: {src: '/integrations/linear.svg', fill: true},
};

export const INTEGRATIONS: Integration[] = CATALOG.map((integration) => ({
	...integration,
	logo: LOGOS[integration.id],
}));

export function findIntegration(id: string): Integration | undefined {
	return INTEGRATIONS.find((integration) => integration.id === id);
}

/** What the catalog says when a sign-in came back with `?error=<integration>`. */
export function signInFailedMessage(integrationId: string | null): string | null {
	const failed = findIntegration(integrationId ?? '');
	if (!failed) {
		return null;
	}
	return `Signing in to ${failed.name} didn’t finish. Try again.`;
}
