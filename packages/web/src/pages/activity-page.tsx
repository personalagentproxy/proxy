import {useLoaderData, useSearchParams} from 'react-router';
import {AppShell, PageTitle} from '@/components/app-shell';
import {AuditList} from '@/components/audit-list';
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@proxy/ui/components/select';
import {connectionLabel} from '@/lib/access';
import {findAgentProvider} from '@proxy/agent-providers';
import type {activityLoader} from '@/loaders';

const ALL = 'all';

type Option = {value: string; label: string};

// Every request an agent made, newest first, narrowed by agent and connection. The filters live
// in the URL, so the agent and connection pages can link straight to their part of the log, and
// the api applies them.
export function ActivityPage() {
	const {
		entries,
		agents: allAgents,
		connections: allConnections,
	} = useLoaderData<typeof activityLoader>();
	const [params, setParams] = useSearchParams();
	const agent = params.get('agent') ?? ALL;
	const connection = params.get('connection') ?? ALL;
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
		...allAgents.map((candidate) => ({
			value: candidate.id,
			label:
				(candidate.providerId ? findAgentProvider(candidate.providerId)?.name : undefined) ??
				candidate.name,
		})),
	];
	const connections: Option[] = [
		{value: ALL, label: 'All connections'},
		...allConnections.map((candidate) => ({
			value: candidate.id,
			label: connectionLabel(allConnections, candidate),
		})),
	];

	return (
		<AppShell title={<PageTitle detail={`${entries.length} requests`}>Activity</PageTitle>}>
			<div className="mb-3 flex gap-2 md:px-3">
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
			</div>
			<AuditList entries={entries} agents={allAgents} connections={allConnections} />
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
			<SelectTrigger size="sm" aria-label={label} className="min-w-0 flex-1 md:w-48 md:flex-none">
				<SelectValue />
			</SelectTrigger>
			<SelectContent alignItemWithTrigger={false}>
				{options.map((option) => (
					<SelectItem key={option.value} value={option.value}>
						{option.label}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}
