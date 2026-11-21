import {
	CHAT_BUILT_IN_ACTIONS,
	CHAT_INTEGRATION_ID,
	FILES_DEFAULT_ACTIONS,
	FILES_INTEGRATION_ID,
	MEMORY_DEFAULT_ACTIONS,
	MEMORY_INTEGRATION_ID,
	SANDBOX_INTEGRATION_ID,
	VAULT_DEFAULT_ACTIONS,
	VAULT_INTEGRATION_ID,
} from '@proxy/integrations';
import type {StarterConnection} from '@proxy/db/organization';

/**
 * What a member is made with in each organization they are in, its owner as anyone, both called
 * by the organization's name and renamed with it: a vault of their own, what their own agents
 * should know about them, which nobody else there uses; and their Chat, their threads on the Chat
 * page as records, which no agent may do anything with by default but the organization's built-in
 * agent, given everything in its own settings, where the member turns it off as for any agent:
 * what was said in a thread may have come from a connection another agent was never given; their
 * Files, a drive of their own; and their Memory, the notes all their agents share, kept as a
 * drive's files are. Agents may do everything with a drive and a memory by default, since nothing
 * done to either is lost, each write keeping the version before and the trash what was put in it.
 * A vault or a drive to share is one they make beside it (connections/route.ts).
 */
export const MEMBER_CONNECTIONS: StarterConnection[] = [
	{integrationId: VAULT_INTEGRATION_ID, defaults: VAULT_DEFAULT_ACTIONS},
	{integrationId: CHAT_INTEGRATION_ID, defaults: [], builtInGrants: CHAT_BUILT_IN_ACTIONS},
	{integrationId: FILES_INTEGRATION_ID, defaults: FILES_DEFAULT_ACTIONS},
	{integrationId: MEMORY_INTEGRATION_ID, defaults: MEMORY_DEFAULT_ACTIONS},
];

/** The integrations whose connections are called by the organization's name: the vaults, the Chats, the Files and the Memory, and the Sandboxes made later (native/sandbox/connections.ts). */
export const NAMED_AFTER_ORGANIZATION: string[] = [VAULT_INTEGRATION_ID, CHAT_INTEGRATION_ID, SANDBOX_INTEGRATION_ID, FILES_INTEGRATION_ID, MEMORY_INTEGRATION_ID];
