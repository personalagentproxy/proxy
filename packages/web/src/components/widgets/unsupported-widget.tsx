import {BotIcon} from 'lucide-react';
import {Link} from 'react-router';
import {buttonVariants} from '@proxy/ui/components/button';
import {WidgetFrame} from '@/components/widgets/widget-frame';
import type {AgentLogin} from '@/lib/types';
import {useOrgSlug} from '@/hooks/use-org';

// "Claude", "Claude or Poke", and past two, "one of your agents".
function whomToAsk(agents: AgentLogin[]): string {
	const [first, second] = agents;
	if (agents.length > 2 || !first) {
		return 'one of your agents';
	}
	return second ? `${first.name} or ${second.name}` : first.name;
}

// What is typed fits no widget: the input only does a few things, so it says which, and that the
// rest is for the person's agent, or, with none yet, offers to add one.
export function UnsupportedWidget({agents}: {agents: AgentLogin[]}) {
	const org = useOrgSlug();
	const active = agents.filter((agent) => agent.revokedAt === null);
	return (
		<WidgetFrame
			icon={BotIcon}
			name="Not a quick action (yet)"
			actions={
				active.length === 0 && (
					<Link
						to={`/${org}/agents/new`}
						className={buttonVariants({size: 'sm', variant: 'outline'})}
					>
						Add an agent
					</Link>
				)
			}
		>
			<p>
				Quick actions make events, find people, emails and files, write emails, do math and convert
				units, and show your balances and spending.{' '}
				{active.length > 0
					? `For anything else, ask ${whomToAsk(active)}, which can work with your connections.`
					: 'For anything else, add an agent and ask it: it can work with your connections.'}
			</p>
		</WidgetFrame>
	);
}
