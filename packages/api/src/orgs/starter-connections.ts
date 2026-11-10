import {SANDBOX_INTEGRATION_ID, VAULT_DEFAULT_ACTIONS, VAULT_INTEGRATION_ID} from '@proxy/integrations';
import type {StarterConnection} from '@proxy/db/organization';

/**
 * What a member is made with in each organization they are in, its owner as anyone: a vault of
 * their own, what their own agents should know about them, which nobody else there uses, called
 * by the organization's name and renamed with it. A vault to share is one they make beside it
 * (connections/route.ts handleCreateVaultRoute).
 */
export const MEMBER_CONNECTIONS: StarterConnection[] = [{integrationId: VAULT_INTEGRATION_ID, defaults: VAULT_DEFAULT_ACTIONS}];

/** The integrations whose connections are called by the organization's name: the vaults, and the Sandboxes made later (native/sandbox/connections.ts). */
export const NAMED_AFTER_ORGANIZATION: string[] = [VAULT_INTEGRATION_ID, SANDBOX_INTEGRATION_ID];
