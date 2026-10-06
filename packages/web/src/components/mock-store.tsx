import {createContext, use, useMemo, useState, type ReactNode} from 'react';
import {Err, Ok, type Result} from 'ts-results-es';
import {generatePassword, generateUsername, newId} from '@/lib/credentials';
import {findIntegration} from '@/lib/integrations';
import {grantKey, initialState, sampleRecords, type MockState} from '@/lib/mock-data';
import type {Access, AgentLogin, AuditEntry} from '@/lib/types';

// Who is signed in on each side. Kept in the tab's session storage so a reload keeps you signed
// in, while everything else starts over from the fixtures.
type Session = {human: boolean; agentId: string | null};

const SESSION_KEY = 'proxy:session';

function readSession(): Session {
	const stored = sessionStorage.getItem(SESSION_KEY);
	if (!stored) {
		return {human: false, agentId: null};
	}
	return JSON.parse(stored) as Session;
}

type Store = {
	state: MockState;
	session: Session;
	// The agent signed in on the agent side, if its login still exists and is not revoked.
	agent: AgentLogin | null;
	signInHuman: () => void;
	signOutHuman: () => void;
	signInAgent: (username: string, password: string) => Result<AgentLogin, string>;
	signOutAgent: () => void;
	connect: (integrationId: string) => string;
	disconnect: (connectionId: string) => void;
	createAgent: (name: string) => string;
	resetPassword: (agentId: string) => void;
	setRevoked: (agentId: string, revoked: boolean) => void;
	deleteAgent: (agentId: string) => void;
	setAccess: (agentId: string, connectionId: string, collectionId: string, access: Access) => void;
	saveRecord: (
		connectionId: string,
		collectionId: string,
		values: Record<string, string>,
		recordId?: string,
	) => string;
	deleteRecord: (recordId: string) => void;
	log: (entry: Omit<AuditEntry, 'id' | 'at' | 'agentId'>) => void;
};

const StoreContext = createContext<Store | null>(null);

export function MockStoreProvider({children}: {children: ReactNode}) {
	const [state, setState] = useState(initialState);
	const [session, setSessionState] = useState(readSession);

	const store = useMemo<Store>(() => {
		const setSession = (next: Session) => {
			sessionStorage.setItem(SESSION_KEY, JSON.stringify(next));
			setSessionState(next);
		};
		const updateAgent = (agentId: string, change: (agent: AgentLogin) => AgentLogin) => {
			setState((current) => ({
				...current,
				agents: current.agents.map((agent) => (agent.id === agentId ? change(agent) : agent)),
			}));
		};
		const signedIn = state.agents.find((agent) => agent.id === session.agentId);

		return {
			state,
			session,
			agent: signedIn && signedIn.revokedAt === null ? signedIn : null,
			signInHuman: () => setSession({...session, human: true}),
			signOutHuman: () => setSession({...session, human: false}),
			signInAgent: (username, password) => {
				const agent = state.agents.find((candidate) => candidate.username === username.trim());
				if (!agent || agent.password !== password) {
					return Err('Wrong username or password.');
				}

				if (agent.revokedAt !== null) {
					return Err('This login has been revoked.');
				}

				setSession({...session, agentId: agent.id});
				return Ok(agent);
			},
			signOutAgent: () => setSession({...session, agentId: null}),
			connect: (integrationId) => {
				const integration = findIntegration(integrationId);
				const id = newId();
				setState((current) => ({
					...current,
					connections: [
						...current.connections,
						{
							id,
							integrationId,
							account: integration?.sampleAccount ?? integrationId,
							connectedAt: new Date().toISOString(),
						},
					],
					records: [...current.records, ...sampleRecords(integrationId, id)],
				}));
				return id;
			},
			// The connection's records go with it, and so does every grant on it.
			disconnect: (connectionId) => {
				const prefix = `${connectionId}/`;
				setState((current) => ({
					...current,
					connections: current.connections.filter((connection) => connection.id !== connectionId),
					records: current.records.filter((record) => record.connectionId !== connectionId),
					agents: current.agents.map((agent) => ({
						...agent,
						grants: Object.fromEntries(
							Object.entries(agent.grants).filter(([key]) => !key.startsWith(prefix)),
						),
					})),
				}));
			},
			createAgent: (name) => {
				const id = newId();
				const agent: AgentLogin = {
					id,
					name: name.trim(),
					username: generateUsername(name),
					password: generatePassword(),
					createdAt: new Date().toISOString(),
					lastActiveAt: null,
					revokedAt: null,
					grants: {},
				};
				setState((current) => ({...current, agents: [agent, ...current.agents]}));
				return id;
			},
			resetPassword: (agentId) =>
				updateAgent(agentId, (agent) => ({...agent, password: generatePassword()})),
			setRevoked: (agentId, revoked) =>
				updateAgent(agentId, (agent) => ({
					...agent,
					revokedAt: revoked ? new Date().toISOString() : null,
				})),
			deleteAgent: (agentId) =>
				setState((current) => ({
					...current,
					agents: current.agents.filter((agent) => agent.id !== agentId),
				})),
			setAccess: (agentId, connectionId, collectionId, access) =>
				updateAgent(agentId, (agent) => ({
					...agent,
					grants: {...agent.grants, [grantKey(connectionId, collectionId)]: access},
				})),
			saveRecord: (connectionId, collectionId, values, recordId) => {
				const id = recordId ?? newId();
				const updatedAt = new Date().toISOString();
				setState((current) => {
					if (recordId === undefined) {
						return {
							...current,
							records: [{id, connectionId, collectionId, values, updatedAt}, ...current.records],
						};
					}

					return {
						...current,
						records: current.records.map((record) =>
							record.id === recordId ? {...record, values, updatedAt} : record,
						),
					};
				});
				return id;
			},
			deleteRecord: (recordId) =>
				setState((current) => ({
					...current,
					records: current.records.filter((record) => record.id !== recordId),
				})),
			// Every request the agent side makes lands here, signed in as the current agent.
			log: (entry) => {
				const agentId = session.agentId;
				if (agentId === null) {
					return;
				}

				const at = new Date().toISOString();
				setState((current) => ({
					...current,
					audit: [{...entry, id: newId(), at, agentId}, ...current.audit],
					agents: current.agents.map((agent) =>
						agent.id === agentId ? {...agent, lastActiveAt: at} : agent,
					),
				}));
			},
		};
	}, [state, session]);

	return <StoreContext value={store}>{children}</StoreContext>;
}

export function useStore(): Store {
	const store = use(StoreContext);
	if (!store) {
		throw new Error('useStore needs a MockStoreProvider');
	}
	return store;
}
