import {IdCardIcon, MailIcon, type LucideIcon} from 'lucide-react';
import {
	INTEGRATIONS as CATALOG,
	type Integration as CatalogIntegration,
	type IntegrationId,
} from '@proxy/integrations';

// A brand's own logo where it has one (in `public/integrations/`), else an icon: Information is
// ours, and Email is any mailbox. A logo that is already a square tile, as Granola's, Linear's and
// TickTick's are, fills the tile edge to edge.
type IntegrationLogoImage = {src: string; fill?: boolean};

export type Integration = CatalogIntegration & {logo: LucideIcon | IntegrationLogoImage};

const LOGOS: Record<IntegrationId, LucideIcon | IntegrationLogoImage> = {
	info: IdCardIcon,
	email: MailIcon,
	granola: {src: '/integrations/granola.png', fill: true},
	notion: {src: '/integrations/notion.svg'},
	linear: {src: '/integrations/linear.svg', fill: true},
	ticktick: {src: '/integrations/ticktick.svg', fill: true},
	postgres: {src: '/integrations/postgresql.svg'},
	mysql: {src: '/integrations/mysql.svg'},
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

/** What the catalog's plus leads to for a database: the form's title and where the database has to be. */
export function describeDatabase(dialect: 'postgres' | 'mysql'): {title: string; intro: string} {
	const name = findIntegration(dialect)?.name ?? dialect;
	return {
		title: `Connect a ${name} database`,
		intro:
			'Sign in with a database user made for this connection alone. The database has to be reachable from the internet; one on a private address needs Personal Agent Proxy self-hosted beside it.',
	};
}

/** What the TickTick form says before it: where the token is, and that revoking it disconnects. */
export const TICKTICK_INTRO =
	'Sign in with a personal API token from TickTick’s settings. Making a new token there replaces this one and disconnects the account.';
