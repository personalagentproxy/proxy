import type {AgentLogin} from '@proxy/contracts/agents';
import type {Connection} from '@proxy/contracts/connections';
import type {Me} from '@proxy/contracts/me';
import type {Org} from '@proxy/contracts/orgs';
import {findIntegration} from '@proxy/integrations';
import {isBuiltInAgent} from '@/lib/access';

// The human side's organizations: the one in the address, and who else is in each.

// What the human side's route loads: who is signed in, the organization the address names, and
// the organizations they are in, for the switcher.
export type Human = Me & {org: Org; orgs: Org[]};

/**
 * The person's account page, which is no organization's, opened from `org`: the address keeps
 * which one the sidebar and the command bar stay in while it is up, the first one's where it names
 * none of the person's.
 */
export function accountPath(org: string): string {
	if (org === '') {
		return '/account';
	}
	return `/account?org=${encodeURIComponent(org)}`;
}

/** Whether anyone else is in the organization or invited to it. */
export function hasOtherPeople(org: Org): boolean {
	return org.memberCount > 1 || org.invitationCount > 0;
}

// A connection, with whose it is, or an agent, with who made it.
type Managed =
	| Pick<Connection, 'ownerUserId' | 'sharedWithEveryone'>
	| {shared: boolean; createdById: string | null};

/**
 * Whether the person may change a connection or an agent, as the api decides it. A connection:
 * their own, or, as the organization's owner, one shared with every member; anyone else it is
 * shared with uses it as it is. An agent: their own, or a shared one they made, or one in an
 * organization they own.
 */
export function manages(human: Human, item: Managed): boolean {
	if ('ownerUserId' in item) {
		return (
			item.ownerUserId === human.user.id || (item.sharedWithEveryone && human.org.role === 'owner')
		);
	}
	return !item.shared || item.createdById === human.user.id || human.org.role === 'owner';
}

/**
 * Whether the person may change an agent's settings on a connection, as the api decides it: the
 * built-in agent's where they change the connection's defaults, any other agent's where they change
 * the agent.
 */
export function managesAgentOn(
	human: Human,
	agent: AgentLogin,
	connection: Pick<Connection, 'ownerUserId' | 'sharedWithEveryone'>,
): boolean {
	if (isBuiltInAgent(agent)) {
		return manages(human, connection);
	}
	return manages(human, agent);
}

/**
 * Whose a connection is, at the start of a line: "You", a member by their name or address, or "A
 * former member" for one no longer in the organization.
 */
export function ownerOf(connection: Connection, human: Human): string {
	if (connection.ownerUserId === human.user.id) {
		return 'You';
	}
	return connection.owner ?? 'A former member';
}

/**
 * Who the provider sees when an agent uses the connection: whoever signed in, for an integration
 * connected by signing in to it; the account itself for a mailbox, a database's user, a key or a
 * custom server.
 */
export function actsAs(connection: Connection, human: Human): string {
	if (!findIntegration(connection.integrationId)?.signIn) {
		return connection.account;
	}
	if (connection.ownerUserId === human.user.id) {
		return 'you, who signed in';
	}
	return `${connection.owner ?? 'a former member'}, who signed in`;
}
