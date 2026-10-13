import {mcpToolReadsOnly, mcpToolTitle} from '@proxy/integrations';
import {useLocation} from 'react-router';
import {AgentHeading, AgentShell} from '@/components/agent-shell';
import {IntegrationLogo} from '@/components/brand-logo';
import {Row, RowList} from '@/components/row-list';
import {Section} from '@/components/section';
import {useAgentMe} from '@/hooks/use-agent-target';
import {allows, canStartNew, describeActions} from '@/lib/access';
import {integrationOf} from '@/lib/integrations';
import {noticeFromState} from '@/pages/agent/agent-collection-page';

// Everything this login can do, connection by connection: what it is allowed, and the lists it can
// open. A list it can neither read nor add to is left out, so the agent never sees a door it
// cannot open. A custom MCP server's tools are the rows, each the agent may run.
export function AgentHomePage() {
	const connections = useAgentMe()?.connections ?? [];
	const notice = noticeFromState(useLocation().state);

	return (
		<AgentShell>
			<div className="flex flex-col gap-8">
				<div className="md:px-3">
					<AgentHeading>What you can access</AgentHeading>
					{notice && <p className="mt-2 text-sm">{notice}.</p>}
				</div>
				{connections.length === 0 && (
					<p className="text-sm text-muted-foreground md:px-3">
						No connections are available to this login yet. Ask the person who set it up to add a
						service on the Connections page, or give this login access to one already connected.
					</p>
				)}
				{connections.map((connection) => {
					const integration = integrationOf(connection);
					if (!integration) {
						return null;
					}
					if (integration.custom) {
						const tools = (connection.tools ?? []).filter((tool) =>
							connection.actions.includes(tool.name),
						);
						return (
							<Section
								key={connection.id}
								title={
									<>
										<IntegrationLogo
											integration={integration}
											className="mr-2 inline-flex align-middle"
										/>
										{connection.name ?? integration.name}
									</>
								}
								detail={connection.account}
							>
								<p className="text-sm text-muted-foreground md:px-3">
									The server's tools you may run, each with the params it takes.
								</p>
								<RowList>
									{tools.map((tool) => (
										<Row
											key={tool.name}
											to={`/agent/${connection.id}/tool/${encodeURIComponent(tool.name)}`}
											title={mcpToolTitle(tool)}
											cells={
												<span className="shrink-0 text-muted-foreground">
													{mcpToolReadsOnly(tool) ? 'Only reads' : 'Changes something'}
												</span>
											}
										/>
									))}
								</RowList>
							</Section>
						);
					}
					const collections = integration.collections.filter(
						(collection) =>
							allows(collection, connection.actions, 'list') ||
							canStartNew(collection, connection.actions),
					);
					return (
						<Section
							key={connection.id}
							title={
								<>
									<IntegrationLogo
										integration={integration}
										className="mr-2 inline-flex align-middle"
									/>
									{integration.name}
								</>
							}
							detail={connection.account}
						>
							<p className="text-sm text-muted-foreground md:px-3">
								You can: {describeActions(integration, connection.actions)}.
							</p>
							<RowList>
								{collections.map((collection) => {
									// One that can only add, as when sending without reading, opens on its form.
									const base = `/agent/${connection.id}/${collection.id}`;
									const readable = allows(collection, connection.actions, 'list');
									return (
										<Row
											key={collection.id}
											to={readable ? base : `${base}/new`}
											title={readable ? collection.name : `New ${collection.singular}`}
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
