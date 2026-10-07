import {useLocation} from 'react-router';
import {AgentHeading, AgentShell} from '@/components/agent-shell';
import {Row, RowList} from '@/components/row-list';
import {Section} from '@/components/section';
import {useAgentMe} from '@/hooks/use-agent-target';
import {allows, canStartNew, describeActions} from '@/lib/access';
import {findIntegration} from '@/lib/integrations';
import {noticeFromState} from '@/pages/agent/agent-collection-page';

// Everything this login can do, connection by connection: what it is allowed, and the lists it can
// open. A list it can neither read nor add to is left out, so the agent never sees a door it
// cannot open.
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
						This login has no access yet. Ask the person who made it to give it some.
					</p>
				)}
				{connections.map((connection) => {
					const integration = findIntegration(connection.integrationId);
					if (!integration) {
						return null;
					}
					const collections = integration.collections.filter(
						(collection) =>
							allows(collection, connection.actions, 'list') ||
							canStartNew(collection, connection.actions),
					);
					return (
						<Section key={connection.id} title={integration.name} detail={connection.account}>
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
