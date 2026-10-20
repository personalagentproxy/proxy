import {useId, useState} from 'react';
import {Link, useSearchParams} from 'react-router';
import {sendAgentFeedback} from '@/client/agent-client';
import {AgentHeading, AgentShell, Crumbs} from '@/components/agent-shell';
import {SuccessLine} from '@/components/success-line';
import {Button} from '@proxy/ui/components/button';
import {Label} from '@proxy/ui/components/label';
import {Textarea} from '@proxy/ui/components/textarea';
import {useAgentMe} from '@/hooks/use-agent-target';
import {agentErrorMessage} from '@/lib/agent-errors';
import {taskHome, TASKS_PATH} from '@/lib/agent-task';

// Feedback for the makers of Personal Agent Proxy, as the MCP server's send_feedback takes it: what
// the agent tried, what happened and what it expected. Opened from the link at the foot of every
// agent page, which says the task, the connection and the tool it was on, `?task=`,
// `?connection=` and `?tool=`, sent along with it; it leads back to the task's pages, or to the
// task list from a page of none.
export function AgentFeedbackPage() {
	const id = useId();
	const [params] = useSearchParams();
	const connections = useAgentMe()?.connections ?? [];
	const [message, setMessage] = useState('');
	const [error, setError] = useState<string | null>(null);
	const [sending, setSending] = useState(false);
	const [sent, setSent] = useState(false);
	const connectionId = params.get('connection') ?? undefined;
	const tool = params.get('tool') ?? undefined;
	const task = params.get('task') ?? undefined;
	const back = task ? taskHome(task) : TASKS_PATH;
	const connection = connections.find((candidate) => candidate.id === connectionId);
	const about = [connection && (connection.name ?? connection.account), tool]
		.filter(Boolean)
		.join(', ');

	const send = async () => {
		setSending(true);
		setError(null);
		const result = await sendAgentFeedback({message, connection: connectionId, tool, task});
		setSending(false);
		if (result.isErr()) {
			setError(agentErrorMessage(result.error));
			return;
		}
		setMessage('');
		setSent(true);
	};

	return (
		<AgentShell feedback={false}>
			<Crumbs items={[{label: 'Home', to: back}, {label: 'Send feedback'}]} />
			<AgentHeading>Send feedback</AgentHeading>
			<div className="flex flex-col gap-4">
				<p className="text-sm text-muted-foreground">
					Tell the makers of Personal Agent Proxy about something that didn’t work as you expected:
					a page or button that failed or showed something odd, a hint or error that misled you, or
					something you needed and couldn’t do. Say what you tried, what happened and what you
					expected. It goes to the makers, not to the person, and changes nothing in their accounts.
					Leave out the person’s private information, such as what an email says.
				</p>
				{sent && (
					<SuccessLine>
						<span>
							Sent, thank you. You can send more, or go back to{' '}
							<Link to={back} className="underline underline-offset-4">
								{task ? 'what you can access' : 'your tasks'}
							</Link>
							.
						</span>
					</SuccessLine>
				)}
				<form
					className="grid gap-4"
					onSubmit={(event) => {
						event.preventDefault();
						void send();
					}}
				>
					<div className="grid gap-2">
						<Label htmlFor={id}>Feedback</Label>
						<Textarea
							id={id}
							rows={6}
							value={message}
							onChange={(event) => setMessage(event.target.value)}
						/>
						{about && <p className="text-sm text-muted-foreground">About {about}.</p>}
					</div>
					{error && <p className="text-sm text-destructive">{error}</p>}
					<div className="flex justify-end">
						<Button type="submit" disabled={sending || message.trim() === ''}>
							{sending ? 'Sending…' : 'Send feedback'}
						</Button>
					</div>
				</form>
			</div>
		</AgentShell>
	);
}
