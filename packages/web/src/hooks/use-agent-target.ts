import {useParams} from 'react-router';
import {useStore} from '@/components/mock-store';
import {accessFor, locate, type Located} from '@/lib/access';
import type {Access} from '@proxy/integrations';

// The connection and collection an agent page's URL points at, with the signed-in agent's
// access to them; null when the URL names no such collection.
export function useAgentTarget(): (Located & {access: Access}) | null {
	const {connectionId = '', collectionId = ''} = useParams();
	const {state, agent} = useStore();
	const located = locate(state, connectionId, collectionId);
	if (!agent || !located) {
		return null;
	}

	return {...located, access: accessFor(agent, connectionId, collectionId)};
}
