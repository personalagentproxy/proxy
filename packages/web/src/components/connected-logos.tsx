import {Tooltip, TooltipContent, TooltipTrigger} from '@proxy/ui/components/tooltip';
import type {ReactNode} from 'react';
import {Link} from 'react-router';
import {AgentLogo, IntegrationLogo} from '@/components/brand-logo';
import {useOrgSlug} from '@/hooks/use-org';
import {connectionLabel} from '@/lib/access';
import {counted} from '@/lib/format';
import {integrationOf, type Integration} from '@/lib/integrations';
import type {AgentLogin, Connection} from '@/lib/types';

const TILE = 'size-6 rounded-md ring-2 ring-background';

// The logos a stack shows at most; the count beside it says how many there are.
const SHOWN = 8;

// The connections as the stack shows them: one logo per integration, its connections behind it,
// The vault left out, since every organization has it. A custom MCP server is its own.
function sourcesOf(connections: Connection[]): Array<{integration: Integration; names: string[]}> {
	const sources: Array<{integration: Integration; names: string[]}> = [];
	for (const connection of connections) {
		const integration = integrationOf(connection);
		if (!integration || integration.builtIn) {
			continue;
		}
		const name = connectionLabel(connections, connection);
		const known = sources.find(
			(source) => source.integration.id === integration.id && !integration.custom,
		);
		if (known) {
			known.names.push(name);
			continue;
		}
		sources.push({integration, names: [name]});
	}
	return sources;
}

// Under the home page's input: the sources and the agents connected, each a stack of logos with
// its name on hover, leading to their pages; with none yet, a link to connect one.
export function ConnectedLogos({
	connections,
	agents,
}: {
	connections: Connection[];
	agents: AgentLogin[];
}) {
	const org = useOrgSlug();
	const sources = sourcesOf(connections);
	const sourceCount = sources.reduce((count, source) => count + source.names.length, 0);
	const active = agents.filter((agent) => agent.revokedAt === null);

	return (
		<div className="flex items-center justify-center gap-6 text-sm text-muted-foreground">
			<Group
				to={sourceCount > 0 ? `/${org}/connections` : `/${org}/connections/new`}
				label={sourceCount > 0 ? counted(sourceCount, 'source') : 'Connect a source'}
			>
				{sources.slice(0, SHOWN).map(({integration, names}) => (
					<Logo
						key={names[0]}
						name={
							names.length > 1
								? `${integration.name} · ${names.length} accounts`
								: (names[0] ?? integration.name)
						}
					>
						<IntegrationLogo integration={integration} className={TILE} />
					</Logo>
				))}
			</Group>
			<Group
				to={active.length > 0 ? `/${org}/agents` : `/${org}/agents/new`}
				label={active.length > 0 ? counted(active.length, 'agent') : 'Add an agent'}
			>
				{active.slice(0, SHOWN).map((agent) => (
					<Logo key={agent.id} name={agent.name}>
						<AgentLogo providerId={agent.providerId} className={TILE} />
					</Logo>
				))}
			</Group>
		</div>
	);
}

function Group({to, label, children}: {to: string; label: string; children: ReactNode[]}) {
	return (
		<Link to={to} className="flex items-center gap-2 transition-colors hover:text-foreground">
			{children.length > 0 && <span className="flex -space-x-1.5">{children}</span>}
			{label}
		</Link>
	);
}

function Logo({name, children}: {name: string; children: ReactNode}) {
	return (
		<Tooltip>
			<TooltipTrigger render={<span className="transition-transform hover:-translate-y-0.5" />}>
				{children}
			</TooltipTrigger>
			<TooltipContent>{name}</TooltipContent>
		</Tooltip>
	);
}
