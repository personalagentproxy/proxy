import {findCollection} from '@proxy/integrations';
import {AgentHeading, AgentShell} from '@/components/agent-shell';
import {Row, RowList} from '@/components/row-list';
import {Section} from '@/components/section';
import {useAgentMe} from '@/hooks/use-agent-target';
import {describeActions} from '@/lib/access';
import {findIntegration} from '@/lib/integrations';

// Everything this login can reach, connection by connection. Collections without access are
// left out, so the agent never sees a door it cannot open.
export function AgentHomePage() {
	const connections = useAgentMe()?.connections ?? [];

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
				{connections.map((connection) => {
					const integration = findIntegration(connection.integrationId);
					if (!integration) {
						return null;
					}
					return (
						<Section key={connection.id} title={integration.name} detail={connection.account}>
							<RowList>
								{connection.collections.map(({id, actions}) => {
									const collection = findCollection(integration, id);
									if (!collection) {
										return null;
									}
									return (
										<Row
											key={id}
											to={`/agent/${connection.id}/${id}`}
											title={collection.name}
											cells={
												<span className="max-w-[60%] shrink-0 truncate text-muted-foreground">
													{describeActions(collection, actions)}
												</span>
											}
										/>
									);
								})}
							</RowList>
						</Section>
					);
				})}
			</div>
		</AgentShell>
	);
}
