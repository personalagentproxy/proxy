import type {IntegrationId} from '@proxy/integrations';

import {CLOUDFLARE_INTEGRATION} from './cloudflare/integration';
import {CUSTOM_MCP_INTEGRATION} from './custom/integration';
import {EMAIL_INTEGRATION} from './email/integration';
import {EXA_INTEGRATION} from './exa/integration';
import {GOOGLE_INTEGRATION} from './google/integration';
import {GRANOLA_INTEGRATION} from './granola/integration';
import type {ApiIntegration} from './integration';
import {LINEAR_INTEGRATION} from './linear/integration';
import {MYSQL_INTEGRATION} from './mysql/integration';
import {NOTION_INTEGRATION} from './notion/integration';
import {PARALLEL_INTEGRATION} from './parallel/integration';
import {PLAID_INTEGRATION} from './plaid/integration';
import {POSTGRES_INTEGRATION} from './postgres/integration';
import {VAULT_INTEGRATION} from './vault/integration';

/**
 * Every integration of the catalog's, as the api knows it (`integration.ts`), by its id: adding one
 * to the catalog needs its module here, which `integrations.test.ts` checks against the catalog. It
 * is read when asked for rather than as this file loads, since what a module's routes reach, such
 * as how a connection is answered, reads it in turn.
 */
function modules(): Record<IntegrationId, ApiIntegration> {
	return {
		vault: VAULT_INTEGRATION,
		email: EMAIL_INTEGRATION,
		granola: GRANOLA_INTEGRATION,
		notion: NOTION_INTEGRATION,
		linear: LINEAR_INTEGRATION,
		cloudflare: CLOUDFLARE_INTEGRATION,
		exa: EXA_INTEGRATION,
		parallel: PARALLEL_INTEGRATION,
		postgres: POSTGRES_INTEGRATION,
		mysql: MYSQL_INTEGRATION,
		mcp: CUSTOM_MCP_INTEGRATION,
		google: GOOGLE_INTEGRATION,
		plaid: PLAID_INTEGRATION,
	};
}

/** Every integration's module. */
export function apiIntegrations(): ApiIntegration[] {
	return Object.values(modules());
}

/** An integration's module, by its id; none for an id the catalog lacks. */
export function apiIntegration(integrationId: string): ApiIntegration | undefined {
	return apiIntegrations().find((integration) => integration.id === integrationId);
}
