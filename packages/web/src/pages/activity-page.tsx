import type {ReactNode} from 'react';
import {useLoaderData, useSearchParams} from 'react-router';
import {AgentTimeline} from '@/components/agent-timeline';
import {AppShell, PageTitle} from '@/components/app-shell';
import {AuditList} from '@/components/audit-list';
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@proxy/ui/components/select';
import {AgentLogo, IntegrationLogo, ProxyLogo} from '@/components/brand-logo';
import {connectionLabel} from '@/lib/access';
import {integrationOf} from '@/lib/integrations';
import type {activityLoader} from '@/loaders';

const ALL = 'all';

type Option = {value: string; label: string; icon?: ReactNode};

const OUTCOMES: Option[] = [
	{value: ALL, label: 'All outcomes'},
	{value: 'allowed', label: 'Allowed'},
	{value: 'denied', label: 'Blocked'},
	{value: 'failed', label: 'Failed'},
];

// The home page's timeline of who is doing what, over every request an agent made, and what
// Personal Agent Proxy did itself from the home page, newest first, narrowed by agent, connection
// and outcome. The filters live in the URL, so the agent and connection pages can link straight to
// their part of the log, and the api applies them (`?agent=proxy` for Personal Agent Proxy's own,
// `?outcome=denied` for what was refused, `?outcome=failed` for what the provider failed). One
// task's requests are on its own page (task-page.tsx), which an old `?task=` link is sent to.
export function ActivityPage() {
	const {
		entries,
		tasks,
		timeline,
		agents: allAgents,
		connections: allConnections,
	} = useLoaderData<typeof activityLoader>();
	const [params, setParams] = useSearchParams();
	const agent = params.get('agent') ?? ALL;
	const connection = params.get('connection') ?? ALL;
	const outcome = params.get('outcome') ?? ALL;
	const filter = (key: string, value: string) => {
		const next = new URLSearchParams(params);
		if (value === ALL) {
			next.delete(key);
		}
		if (value !== ALL) {
			next.set(key, value);
		}
		setParams(next, {replace: true});
	};

	const agents: Option[] = [
		{value: ALL, label: 'All agents'},
		{value: 'proxy', label: 'Personal Agent Proxy', icon: <ProxyLogo />},
		...allAgents.map((candidate) => ({
			value: candidate.id,
			label: candidate.name,
			icon: <AgentLogo providerId={candidate.providerId} />,
		})),
	];
	const connections: Option[] = [
		{value: ALL, label: 'All connections'},
		...allConnections.map((candidate) => {
			const integration = integrationOf(candidate);
			return {
				value: candidate.id,
				label: connectionLabel(allConnections, candidate),
				icon: integration ? <IntegrationLogo integration={integration} /> : undefined,
			};
		}),
	];

	return (
		<AppShell title={<PageTitle>Activity</PageTitle>}>
			{timeline && (
				<AgentTimeline initial={timeline} agents={allAgents} connections={allConnections} />
			)}
			<div className="flex flex-wrap gap-2 md:flex-nowrap">
				<Filter
					label="Agent"
					options={agents}
					value={agent}
					onChange={(value) => filter('agent', value)}
				/>
				<Filter
					label="Connection"
					options={connections}
					value={connection}
					onChange={(value) => filter('connection', value)}
				/>
				<Filter
					label="Outcome"
					options={OUTCOMES}
					value={outcome}
					onChange={(value) => filter('outcome', value)}
				/>
			</div>
			<AuditList entries={entries} agents={allAgents} connections={allConnections} tasks={tasks} />
		</AppShell>
	);
}

type FilterProps = {
	label: string;
	options: Option[];
	value: string;
	onChange: (value: string) => void;
};

function Filter({label, options, value, onChange}: FilterProps) {
	const selected = options.find((option) => option.value === value);
	return (
		<Select
			value={value}
			items={options}
			onValueChange={(next) => {
				if (next !== null) {
					onChange(next);
				}
			}}
		>
			<SelectTrigger
				size="sm"
				aria-label={label}
				className="min-w-0 flex-1 basis-[calc(50%-0.25rem)] md:w-48 md:flex-none md:basis-auto"
			>
				<SelectValue>
					{selected?.icon}
					{selected?.label}
				</SelectValue>
			</SelectTrigger>
			<SelectContent alignItemWithTrigger={false}>
				{options.map((option) => (
					<SelectItem key={option.value} value={option.value}>
						{option.icon}
						{option.label}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}
