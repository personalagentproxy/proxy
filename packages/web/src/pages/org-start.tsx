import {Navigate} from 'react-router';

/**
 * The organization's own address (`/:org`), where the app opens: Chat, which opens the person's
 * last conversation.
 */
export function OrgStart() {
	return <Navigate replace to="chat" />;
}
