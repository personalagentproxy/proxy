import {IdCardIcon, MailIcon, type LucideIcon} from 'lucide-react';
import {
	INTEGRATIONS as CATALOG,
	integrationFor,
	type Integration as CatalogIntegration,
	type IntegrationId,
	type McpTool,
} from '@proxy/integrations';
import type {Experiment} from '@proxy/utils';

// A brand's own logo where it has one (in `public/integrations/`), else an icon: Information is
// ours and Email is any mailbox. Custom MCP servers use our mark because Personal Agent Proxy is
// the service connecting them. A logo that is already a square tile, as Granola's and Linear's
// are, fills the tile edge to edge.
type IntegrationLogoImage = {src: string; fill?: boolean};

export type Integration = CatalogIntegration & {
	logo: LucideIcon | IntegrationLogoImage;
	// What the server has to have before the integration can be connected, such as Google's client.
	needs?: Need;
	// The experiment the organization needs on before the catalog offers it.
	experiment?: Experiment;
};

// What an integration can need from the server, and whether it has it: the answer of
// `/auth/methods`, since Google sign-in and Google connections share the client, and a bank needs
// the server's Plaid keys.
export type Need = 'google' | 'plaid';

export type Configured = Record<Need, boolean>;

// What each need is on the server, for a self-hoster to set up, and the docs page on it.
export const NEEDS: Record<Need, {variables: string[]; docsUrl: string}> = {
	google: {
		variables: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'],
		docsUrl: 'https://docs.personalagentproxy.com/connections/google/',
	},
	plaid: {
		variables: ['PLAID_CLIENT_ID', 'PLAID_SECRET'],
		docsUrl: 'https://docs.personalagentproxy.com/connections/plaid/',
	},
};

const NEEDED_BY: Partial<Record<IntegrationId, Need>> = {google: 'google', plaid: 'plaid'};

const EXPERIMENT_OF: Partial<Record<IntegrationId, Experiment>> = {plaid: 'plaid'};

const LOGOS: Record<IntegrationId, LucideIcon | IntegrationLogoImage> = {
	info: IdCardIcon,
	email: MailIcon,
	google: {src: '/integrations/google.svg'},
	granola: {src: '/integrations/granola.png', fill: true},
	notion: {src: '/integrations/notion.svg'},
	linear: {src: '/integrations/linear.svg', fill: true},
	plaid: {src: '/integrations/plaid.svg'},
	postgres: {src: '/integrations/postgresql.svg'},
	mysql: {src: '/integrations/mysql.svg'},
	mcp: {src: '/favicon.svg'},
};

export const INTEGRATIONS: Integration[] = CATALOG.map((integration) => ({
	...integration,
	logo: LOGOS[integration.id],
	needs: NEEDED_BY[integration.id],
	experiment: EXPERIMENT_OF[integration.id],
}));

/** The catalog's integration: for a custom MCP server, the entry with no actions, since those are a connection's own. */
export function findIntegration(id: string): Integration | undefined {
	return INTEGRATIONS.find((integration) => integration.id === id);
}

/** The integration of a connection, a custom MCP server's with its own tools as actions; null for one the catalog no longer has. */
export function integrationOf(connection: {
	integrationId: string;
	tools?: McpTool[] | null;
}): Integration | null {
	const integration = integrationFor(connection);
	if (!integration) {
		return null;
	}
	return {...integration, logo: LOGOS[integration.id]};
}

// The integrations connected by signing in to them. Their sign-in starts at
// `/api/connections/<id>/start`: the api sends the browser on to the service, and back to the new
// connection, or to the catalog with `?error=<id>` when it didn't finish, or with
// `?error=<id>-unconfigured` when the server lacks what it needs. Started with
// `?returnTo=welcome`, it comes back to the welcome flow's page for the connection, or its catalog;
// with `?account=`, as signing in again from a connection does, the service opens on that account
// where it can.
const SIGN_IN: IntegrationId[] = ['google', 'granola', 'notion', 'linear'];

/** Where signing in to an integration starts, or null for one connected on a form of its own. */
export function signInPath(
	integrationId: string,
	query: {returnTo?: 'welcome'; account?: string} = {},
): string | null {
	if (!SIGN_IN.some((id) => id === integrationId)) {
		return null;
	}
	const params = new URLSearchParams(
		Object.entries(query).flatMap(([key, value]) => (value === undefined ? [] : [[key, value]])),
	);
	const search = params.size > 0 ? `?${params.toString()}` : '';
	return `/api/connections/${integrationId}/start${search}`;
}

/** What the server lacked when a sign-in came back with `?error=<integration>-unconfigured`. */
export function unmetNeed(error: string | null): Need | null {
	const integrationId = error?.match(/^(.+)-unconfigured$/)?.[1];
	return findIntegration(integrationId ?? '')?.needs ?? null;
}

/** What the catalog says when a sign-in came back with `?error=<integration>`. */
export function signInFailedMessage(integrationId: string | null): string | null {
	const failed = findIntegration(integrationId ?? '');
	if (!failed) {
		return null;
	}
	return `Signing in to ${failed.name} didn’t finish. Try again.`;
}

/** What the catalog's plus leads to for a mailbox: the form's title and the password it takes. */
export const EMAIL_FORM = {
	title: 'Connect a mailbox',
	intro:
		'Sign in with an app password made for this connection alone in your mail account. Revoking it there disconnects the mailbox.',
};

/** What the catalog's plus leads to for a bank: the page's title and what connecting it through Plaid does. */
export const PLAID_FORM = {
	title: 'Connect a bank',
	intro:
		'Plaid signs in to your bank in a window of its own and shares the accounts you choose. Agents only ever read them: balances and transactions, each allowed on its own.',
};

/** What the catalog's plus leads to for a database: the form's title and where the database has to be. */
export function describeDatabase(dialect: 'postgres' | 'mysql'): {title: string; intro: string} {
	const name = findIntegration(dialect)?.name ?? dialect;
	return {
		title: `Connect a ${name} database`,
		intro:
			'Sign in with a database user made for this connection alone. The database has to be reachable from the internet; one on a private address needs Personal Agent Proxy self-hosted beside it.',
	};
}
