import {findIntegration, type IntegrationId} from '@proxy/integrations';

import {cloudflareDocsConnector, cloudflareEndpointsConnector, cloudflareRequestsConnector} from './cloudflare-connector';
import type {Connector} from './connector';
import {emailAttachmentsConnector, emailConnector, emailRepliesConnector} from './email-connector';
import {availabilityConnector} from './google-availability';
import {contactsConnector} from './google-contacts';
import {gmailAttachmentsConnector, gmailConnector, gmailRepliesConnector} from './google-emails';
import {eventsConnector} from './google-events';
import {filesConnector} from './google-files';
import {otherContactsConnector} from './google-other-contacts';
import {rangesConnector} from './google-ranges';
import {tasksConnector} from './google-tasks';
import {granolaNotesConnector, granolaTranscriptsConnector} from './granola-connector';
import {linearConnector} from './linear-connector';
import {notionConnector} from './notion-connector';
import {plaidAccountsConnector, plaidTransactionsConnector} from './plaid-connector';
import {sqlConnectors} from './sql-connector';
import {vaultConnector} from './vault-connector';
import {exaConnectors, parallelConnectors} from './web-connector';

// Each integration's collections by the catalog's collection id, each with a connector of its own,
// so a command runs on the collection it was run on even where two share an id, as Google's Trash
// does for emails and files. `connectors.test.ts` checks each against the catalog. A custom MCP
// server has no records: its tools are called as they are (`connections/custom`).
const CONNECTORS: Record<Exclude<IntegrationId, 'mcp'>, Partial<Record<string, Connector>>> = {
	vault: {entries: vaultConnector},
	email: {emails: emailConnector, attachments: emailAttachmentsConnector, replies: emailRepliesConnector},
	granola: {notes: granolaNotesConnector, transcripts: granolaTranscriptsConnector},
	notion: {pages: notionConnector},
	linear: {issues: linearConnector},
	cloudflare: {requests: cloudflareRequestsConnector, endpoints: cloudflareEndpointsConnector, docs: cloudflareDocsConnector},
	exa: exaConnectors,
	parallel: parallelConnectors,
	postgres: sqlConnectors('postgres'),
	mysql: sqlConnectors('mysql'),
	// A Google account, fetched live from Google's APIs with the connection's tokens, one collection
	// or more per product, each described in its own file.
	google: {
		emails: gmailConnector,
		attachments: gmailAttachmentsConnector,
		replies: gmailRepliesConnector,
		events: eventsConnector,
		availability: availabilityConnector,
		files: filesConnector,
		ranges: rangesConnector,
		contacts: contactsConnector,
		otherContacts: otherContactsConnector,
		tasks: tasksConnector,
	},
	plaid: {accounts: plaidAccountsConnector, transactions: plaidTransactionsConnector},
};

/** The connector of an integration's collection, by their ids; none for a custom MCP server's. */
export function connectorFor(integrationId: string, collectionId: string): Connector | undefined {
	const integration = findIntegration(integrationId);
	if (!integration || integration.id === 'mcp') {
		return undefined;
	}
	return CONNECTORS[integration.id][collectionId];
}
