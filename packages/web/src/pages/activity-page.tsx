import {XIcon} from 'lucide-react';
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
import {Button} from '@proxy/ui/components/button';
import {connectionLabel} from '@/lib/access';
import {daySpan, formatDay} from '@/lib/activity-graph';
import type {activityLoader} from '@/loaders';

const ALL = 'all';

type Option = {value: string; label: string};

const OUTCOMES: Option[] = [
	{value: ALL, label: 'All outcomes'},
	{value: 'allowed', label: 'Allowed'},
	{value: 'denied', label: 'Blocked'},
];

// Every request an agent made, and what Personal Agent Proxy did itself from the home page,
// newest first, narrowed by agent, connection and outcome, and to a day. The filters live in the
// URL, so the agent and connection pages and the home page's graph can link straight to their part
// of the log, and the api applies them (`?agent=proxy` for Personal Agent Proxy's own,
// `?outcome=denied` for what was refused, `?day=2026-10-14` for a day on the browser's clock).
export function ActivityPage() {
	const {
		entries,
		agents: allAgents,
		connections: allConnections,
	} = useLoaderData<typeof activityLoader>();
	const [params, setParams] = useSearchParams();
	const agent = params.get('agent') ?? ALL;
	const connection = params.get('connection') ?? ALL;
	const outcome = params.get('outcome') ?? ALL;
	const day = params.get('day');
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
		{value: 'proxy', label: 'Personal Agent Proxy'},
		...allAgents.map((candidate) => ({value: candidate.id, label: candidate.name})),
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
			<div className="mb-3 flex flex-wrap gap-2 md:flex-nowrap md:px-3">
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
				{day && daySpan(day) && (
					<Button variant="outline" size="sm" onClick={() => filter('day', ALL)}>
						{formatDay(day)}
						<XIcon data-icon="inline-end" />
						<span className="sr-only">Show every day</span>
					</Button>
				)}
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
			<SelectTrigger
				size="sm"
				aria-label={label}
				className="min-w-0 flex-1 basis-[calc(50%-0.25rem)] md:w-48 md:flex-none md:basis-auto"
			>
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
