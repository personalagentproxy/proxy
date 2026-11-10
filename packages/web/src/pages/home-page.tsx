import {useState} from 'react';
import {AgentTimeline} from '@/components/agent-timeline';
import {AppShell} from '@/components/app-shell';
import {CommandBar} from '@/components/command-bar';
import {ConnectedLogos} from '@/components/connected-logos';
import type {homeLoader} from '@/loaders';
import {useHuman} from '@/hooks/use-human';
import {useLoaded} from '@/hooks/use-loaded';
import type {Human} from '@/lib/orgs';

function greeting(me: Human | null, now: Date): string {
	const hour = now.getHours();
	const part = hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening';
	const [first] = (me?.user.name ?? '').split(' ');
	return first ? `Good ${part}, ${first}` : `Good ${part}`;
}

// The start page: a greeting over the command bar (command-bar.tsx), which comes forward over the
// page as it is typed in, then what is connected and what the agents are doing. Cmd+K, which opens
// the bar over any other page, puts the cursor in this one.
export function HomePage() {
	const me = useHuman();
	// The time the page opened, for its greeting.
	const [opened] = useState(() => new Date());
	const hello = greeting(me, opened);

	return (
		<AppShell
			// The greeting and the input's place, until what the input works with has loaded.
			waiting={
				<div className="flex flex-col items-center gap-6 pt-[16vh]">
					<h1 className="text-sm font-medium">{hello}</h1>
					<div
						aria-hidden
						className="h-[calc(3rem+2px)] w-full max-w-2xl rounded-2xl border bg-card shadow-sm"
					/>
				</div>
			}
		>
			<Home hello={hello} />
		</AppShell>
	);
}

function Home({hello}: {hello: string}) {
	const {connections, agents, activity} = useLoaded<typeof homeLoader>();

	return (
		<div className="flex flex-col items-center gap-6 pt-[16vh]">
			<h1 className="text-sm font-medium">{hello}</h1>
			<CommandBar place="page" connections={connections} agents={agents} />
			<ConnectedLogos connections={connections} agents={agents} />
			{activity && (
				<div className="flex w-full justify-center pt-[6vh]">
					<AgentTimeline initial={activity} agents={agents} connections={connections} />
				</div>
			)}
		</div>
	);
}
