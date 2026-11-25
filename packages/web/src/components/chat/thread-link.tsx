import {Link} from 'react-router';
import {useOrgSlug} from '@/hooks/use-org';

/** One of the person's threads, as a link names it: its id, the persona whose chat it is in, its title, and its link in Slack, for one that lives there. */
export type LinkedThread = {id: string; personaId: string; title: string; slackUrl: string | null};

/**
 * A thread, by its title, linked where it lives: its page in Chat, or its thread in Slack, which
 * the app doesn't show, said so after the title and opened in a tab of its own.
 */
export function ThreadLink({
	thread,
	className = 'min-w-0 truncate hover:underline',
}: {
	thread: LinkedThread;
	className?: string;
}) {
	const org = useOrgSlug();
	const title = thread.title || 'Thread';
	if (thread.slackUrl !== null) {
		return (
			<a href={thread.slackUrl} target="_blank" rel="noreferrer" className={className}>
				{title} <span className="text-muted-foreground">in Slack</span>
			</a>
		);
	}
	return (
		<Link to={`/${org}/chat/${thread.personaId}/threads/${thread.id}`} className={className}>
			{title}
		</Link>
	);
}
