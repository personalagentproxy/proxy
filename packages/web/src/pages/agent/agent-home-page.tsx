import {mcpToolReadsOnly, mcpToolTitle} from '@proxy/integrations';
import {useLocation} from 'react-router';
import {AgentHeading, AgentShell} from '@/components/agent-shell';
import {IntegrationLogo} from '@/components/brand-logo';
import {Row, RowList} from '@/components/row-list';
import {Section} from '@/components/section';
import {useAgentMe} from '@/hooks/use-agent-target';
import {allows, canStartNew, describeActions} from '@/lib/access';
import {integrationOf, type Integration} from '@/lib/integrations';
import {taskHome, useTaskId} from '@/lib/agent-task';
import {noticeFromState} from '@/pages/agent/agent-collection-page';

// Everything this login can do, connection by connection: what it is allowed, and the lists it can
// open. A list it can neither read nor add to is left out, so the agent never sees a door it
// cannot open. A custom MCP server's tools are the rows, each the agent may run.
export function AgentHomePage() {
	const connections = useAgentMe()?.connections ?? [];
	const home = taskHome(useTaskId());
	const notice = noticeFromState(useLocation().state);

	return (
		<AgentShell>
			<div className="flex flex-col gap-8">
				<div className="flex flex-col gap-2">
					<AgentHeading>What you can access</AgentHeading>
					{notice && <p className="text-sm">{notice}.</p>}
				</div>
				{connections.length === 0 && (
					<p className="text-sm text-muted-foreground">
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
						const tools = connection.tools ?? [];
						return (
							<Section
								key={connection.id}
								title={
									<>
										<LogoBeforeTitle integration={integration} />
										{connection.name ?? integration.name}
									</>
								}
								detail={connection.account}
							>
								<p className="text-sm text-muted-foreground">
									The server's tools you may run, each with the params it takes.
								</p>
								<RowList>
									{tools.map((tool) => (
										<Row
											key={tool.name}
											to={`${home}/${connection.id}/tool/${encodeURIComponent(tool.name)}`}
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
									<LogoBeforeTitle integration={integration} />
									{integration.name}
								</>
							}
							detail={connection.account}
						>
							<p className="text-sm text-muted-foreground">
								You can: {describeActions(integration, connection.actions)}.
							</p>
							<RowList>
								{collections.map((collection) => {
									// One that can only add, as when sending without reading, opens on its form.
									const base = `${home}/${connection.id}/${collection.id}`;
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

// An integration's logo in the run of a heading's text, centered on it, the space after it its own.
function LogoBeforeTitle({integration}: {integration: Integration}) {
	return (
		<span className="inline-flex pr-2 align-middle">
			<IntegrationLogo integration={integration} />
		</span>
	);
}
