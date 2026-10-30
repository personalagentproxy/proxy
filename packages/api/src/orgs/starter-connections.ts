import {VAULT_DEFAULT_ACTIONS, VAULT_INTEGRATION_ID} from '@proxy/integrations';
import type {StarterConnection} from '@proxy/db/organization';

/**
 * What an organization and its members are made with: every member has their own vault in each
 * organization they are in, what their own agents should know about them, which nobody else
 * there sees; and every organization has one of its own, shared with everyone in it, the shared
 * agents included, made by whoever made the organization. Both are called by the organization's
 * name, and renamed with it.
 */

const OWN_VAULT: StarterConnection = {integrationId: VAULT_INTEGRATION_ID, shared: false, defaults: VAULT_DEFAULT_ACTIONS};

/** What a member gets on joining an organization: their own vault there. */
export const MEMBER_CONNECTIONS: StarterConnection[] = [OWN_VAULT];

/** What an organization is made with: its owner's own vault, and the organization's shared one. */
export const ORGANIZATION_CONNECTIONS: StarterConnection[] = [OWN_VAULT, {...OWN_VAULT, shared: true}];

/** The integrations whose connections are called by the organization's name. */
export const NAMED_AFTER_ORGANIZATION: string[] = [...new Set(ORGANIZATION_CONNECTIONS.map((connection) => connection.integrationId))];
