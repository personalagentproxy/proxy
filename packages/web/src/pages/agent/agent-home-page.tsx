import {AgentHeading, AgentShell} from '@/components/agent-shell';
import {useStore} from '@/components/mock-store';
import {Row, RowList} from '@/components/row-list';
import {Section} from '@/components/section';
import {AGENT_ACCESS_LABELS, reachable} from '@/lib/access';

// Everything this login can reach, connection by connection. Collections without access are
// left out, so the agent never sees a door it cannot open.
export function AgentHomePage() {
	const {state, agent} = useStore();
	const connections = agent ? reachable(state, agent) : [];

	return (
		<AgentShell>
			<div className="flex flex-col gap-8">
				<div className="md:px-3">
					<AgentHeading>What you can access</AgentHeading>
				</div>
				{connections.length === 0 && (
					<p className="text-sm text-muted-foreground md:px-3">
						This login has no access yet. Ask the person who made it to give it some.
					</p>
				)}
				{connections.map(({connection, integration, collections}) => (
					<Section key={connection.id} title={integration.name} detail={connection.account}>
						<RowList>
							{collections.map(({collection, access}) => (
								<Row
									key={collection.id}
									to={`/agent/${connection.id}/${collection.id}`}
									title={collection.name}
									cells={
										<span className="shrink-0 text-muted-foreground">
											{AGENT_ACCESS_LABELS[access]}
										</span>
									}
								/>
							))}
						</RowList>
					</Section>
				))}
			</div>
		</AgentShell>
	);
}
