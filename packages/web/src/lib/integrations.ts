import {LibraryIcon, MailIcon, type LucideIcon} from 'lucide-react';
import {
	INTEGRATIONS as CATALOG,
	integrationFor,
	type Integration as CatalogIntegration,
	type IntegrationId,
	type McpTool,
} from '@proxy/integrations';
import {orgApi} from '@/client/request';

// A brand's own logo, `public/integrations/<id>.svg`, unless `LOGOS` says otherwise. One found on
// the internet has a file of ours to show where it can't be loaded.
type IntegrationLogoImage = {src: string; fill?: boolean; fallback?: string};

export type Integration = CatalogIntegration & {
	logo: LucideIcon | IntegrationLogoImage;
	// What the server has to have before the integration can be connected, such as Google's client.
	needs?: Need;
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

const MCP_MARK = '/favicon.svg';

// The integrations whose logo isn't `public/integrations/<id>.svg` as it is: an icon for those
// that are no one brand's, the vault being ours and Email any mailbox, and our mark for custom
// MCP servers until a connection has its server's site's icon (`serverLogo`); another kind of file;
// or a logo that is already a square tile, as Granola's and Linear's are, which fills the tile
// edge to edge.
const LOGOS: Partial<Record<IntegrationId, LucideIcon | IntegrationLogoImage>> = {
	vault: LibraryIcon,
	email: MailIcon,
	mcp: {src: MCP_MARK},
	granola: {src: '/integrations/granola.png', fill: true},
	linear: {src: '/integrations/linear.svg', fill: true},
};

/** An integration's logo: its file in `public/integrations/`, named by its id, unless `LOGOS` has another. */
export function logoOf(integrationId: IntegrationId): LucideIcon | IntegrationLogoImage {
	return LOGOS[integrationId] ?? {src: `/integrations/${integrationId}.svg`};
}

export const INTEGRATIONS: Integration[] = CATALOG.map((integration) => ({
	...integration,
	logo: logoOf(integration.id),
	needs: NEEDED_BY[integration.id],
}));

/** The catalog's integration: for a custom MCP server, the entry with no actions, since those are a connection's own. */
export function findIntegration(id: string): Integration | undefined {
	return INTEGRATIONS.find((integration) => integration.id === id);
}

/**
 * A custom MCP server's logo, by its connection's account, which is its address,
 * "mcp.sentry.dev/mcp": the icon of the server's site, which the api finds from the main domain of
 * the address, with our mark where there is none.
 */
function serverLogo(account: string): IntegrationLogoImage {
	const address = `https://${account}`;
	if (!URL.canParse(address)) {
		return {src: MCP_MARK};
	}
	return {
		src: `/api/favicons/${encodeURIComponent(new URL(address).hostname)}`,
		fallback: MCP_MARK,
	};
}

/** The integration of a connection, a custom MCP server's with its own tools as actions and its site's icon; null for one the catalog no longer has. */
export function integrationOf(connection: {
	integrationId: string;
	account: string;
	tools?: McpTool[] | null;
}): Integration | null {
	const integration = integrationFor(connection);
	if (!integration) {
		return null;
	}
	const logo = integration.custom ? serverLogo(connection.account) : logoOf(integration.id);
	return {...integration, logo};
}

// The integrations connected by signing in to them, as the catalog marks them (`signIn`). Their
// sign-in starts at `/api/connections/<id>/start`: the api sends the browser on to the service,
// and back to the new connection, or to the catalog with `?error=<id>` when it didn't finish, or
// with `?error=<id>-unconfigured` when the server lacks what it needs. Started with
// `?returnTo=welcome`, it comes back to the welcome flow's page for the connection, or its catalog,
// and with `?returnTo=home`, from a home page widget, to the home page;
// with `?account=`, as signing in again from a connection does, the service opens on that account
// where it can, and with `?connection=` the sign-in renews that connection where its account can't
// be told apart from another's: the integration says nothing of who signed in (`anonymous`), or
// the connection was never signed in to. Otherwise the connection of the account signed in to is
// renewed, or a new one made. With `?share=everyone`, a new connection is for every member of the
// organization rather than the person's own.
/** Where signing in to an integration starts, in the organization `org`, or null for one connected on a form of its own. */
export function signInPath(
	org: string,
	integrationId: string,
	query: {
		returnTo?: 'welcome' | 'home';
		account?: string;
		connection?: string;
		share?: 'everyone';
	} = {},
): string | null {
	if (!findIntegration(integrationId)?.signIn) {
		return null;
	}
	const params = new URLSearchParams(
		Object.entries(query).flatMap(([key, value]) => (value === undefined ? [] : [[key, value]])),
	);
	const search = params.size > 0 ? `?${params.toString()}` : '';
	return `${orgApi(org)}/connections/${integrationId}/start${search}`;
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
export function describeDatabase(dialect: IntegrationId): {title: string; intro: string} {
	const name = findIntegration(dialect)?.name ?? dialect;
	return {
		title: `Connect a ${name} database`,
		intro:
			'Sign in with a database user made for this connection alone. The database has to be reachable from the internet; one on a private address needs Personal Agent Proxy self-hosted beside it.',
	};
}
