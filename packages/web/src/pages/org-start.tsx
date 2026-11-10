import {Navigate} from 'react-router';
import {useExperiments} from '@/hooks/use-experiment';

/**
 * The organization's own address (`/:org`), where the app opens: Chat, which opens the person's
 * last conversation, or Connections in an organization without it (the `harness` experiment).
 */
export function OrgStart() {
	const chat = useExperiments().includes('harness');
	return <Navigate replace to={chat ? 'chat' : 'connections'} />;
}
