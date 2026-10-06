import type {ReactNode} from 'react';
import {Link} from 'react-router';
import {AgentHeading, AgentShell, Crumbs} from '@/components/agent-shell';
import {useStore} from '@/components/mock-store';
import {EmptyRows, Row, RowList} from '@/components/row-list';
import {Button} from '@/components/ui/button';
import {useAgentTarget} from '@/hooks/use-agent-target';
import {useAuditOnce} from '@/hooks/use-audit';
import {AGENT_ACCESS_LABELS, displayValue, recordsOf, recordTitle} from '@/lib/access';

// A collection's records, with New when the agent may write.
export function AgentCollectionPage() {
	const {state} = useStore();
	const target = useAgentTarget();
	const allowed = target !== null && target.access !== 'none';
	useAuditOnce(
		target && {
			connectionId: target.connection.id,
			collectionId: target.collection.id,
			action: 'list',
			recordTitle: null,
			outcome: allowed ? 'allowed' : 'denied',
		},
	);

	if (!target) {
		return <AgentMissing />;
	}

	const {connection, integration, collection, access} = target;
	if (access === 'none') {
		return <AgentDenied>This login has no access to {collection.name}.</AgentDenied>;
	}

	const records = recordsOf(state, connection.id, collection.id);
	const summary = collection.fields.find((field) => field.key === collection.summaryField);
	const base = `/agent/${connection.id}/${collection.id}`;

	return (
		<AgentShell>
			<Crumbs
				items={[{label: 'Home', to: '/agent'}, {label: integration.name}, {label: collection.name}]}
			/>
			<div className="mb-4 flex items-center justify-between gap-4 md:px-3">
				<AgentHeading detail={AGENT_ACCESS_LABELS[access]}>{collection.name}</AgentHeading>
				{access === 'write' && (
					<Button size="sm" nativeButton={false} render={<Link to={`${base}/new`} />}>
						New {collection.singular}
					</Button>
				)}
			</div>
			<RowList>
				{records.length === 0 && <EmptyRows>No {collection.name.toLowerCase()}.</EmptyRows>}
				{records.map((record) => (
					<Row
						key={record.id}
						to={`${base}/${record.id}`}
						title={recordTitle(collection, record)}
						cells={
							summary && (
								<span className="max-w-[40%] shrink-0 truncate text-muted-foreground">
									{displayValue(summary.type, record.values[summary.key])}
								</span>
							)
						}
					/>
				))}
			</RowList>
		</AgentShell>
	);
}

export function AgentMissing() {
	return (
		<AgentShell>
			<Crumbs items={[{label: 'Home', to: '/agent'}, {label: 'Not found'}]} />
			<p className="text-sm text-muted-foreground md:px-3">There is nothing at this address.</p>
		</AgentShell>
	);
}

// What an agent sees when it asks for something it was not given. The request is logged as denied.
export function AgentDenied({children}: {children: ReactNode}) {
	return (
		<AgentShell>
			<Crumbs items={[{label: 'Home', to: '/agent'}, {label: 'No access'}]} />
			<p className="text-sm md:px-3">{children} Ask the person who made it to give it access.</p>
		</AgentShell>
	);
}
