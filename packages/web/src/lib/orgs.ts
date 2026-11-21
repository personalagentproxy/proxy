import type {AgentLogin} from '@proxy/contracts/agents';
import type {Connection} from '@proxy/contracts/connections';
import type {Me} from '@proxy/contracts/me';
import type {Member, Org} from '@proxy/contracts/orgs';
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
 * Whether the person may change an agent's settings on the connections they see, as the api decides
 * it: the built-in agent's on any of them, which hold for everyone's Chat there, since a connection
 * shared with them is theirs to use as they see fit; any other agent's where they change the agent.
 */
export function managesAgentSettings(human: Human, agent: AgentLogin): boolean {
	return isBuiltInAgent(agent) || manages(human, agent);
}

// "Sam", "Sam or Alex", "Sam, Alex or Kim": who may do something, in a sentence.
function eitherOf(names: string[]): string {
	if (names.length < 2) {
		return names[0] ?? '';
	}
	return `${names.slice(0, -1).join(', ')} or ${names.at(-1)}`;
}

// The organization's owners by name, leaving out whoever is named already.
function ownersBeside(members: Member[], named: string | null): string[] {
	return members
		.filter((member) => member.role === 'owner' && member.userId !== named)
		.map((member) => member.name ?? member.email);
}

/**
 * Who may change a connection's defaults, by name, for a person who may not (`manages`): whoever's
 * it is, and for one shared with every member, the organization's owner beside them.
 */
export function connectionSetBy(
	connection: Pick<Connection, 'ownerUserId' | 'owner' | 'sharedWithEveryone'>,
	members: Member[],
): string {
	const owner = connection.owner === null ? [] : [connection.owner];
	if (!connection.sharedWithEveryone) {
		return eitherOf(owner.length > 0 ? owner : ['A former member']);
	}
	const names = [...owner, ...ownersBeside(members, connection.ownerUserId)];
	return eitherOf(names.length > 0 ? names : ['The organization’s owner']);
}

/**
 * Who may change a shared agent's settings, by name, for a person who may not
 * (`managesAgentSettings`): whoever made it and the organization's owner.
 */
export function agentSetBy(agent: AgentLogin, members: Member[]): string {
	const maker = agent.createdBy === null ? [] : [agent.createdBy];
	const names = [...maker, ...ownersBeside(members, agent.createdById)];
	return eitherOf(names.length > 0 ? names : ['The organization’s owner']);
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
