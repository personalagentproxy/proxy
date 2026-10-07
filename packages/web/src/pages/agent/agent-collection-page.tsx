import type {ReactNode} from 'react';
import {Link, useLoaderData, useLocation} from 'react-router';
import {AgentHeading, AgentShell, Crumbs} from '@/components/agent-shell';
import {EmptyRows, Row, RowList} from '@/components/row-list';
import {Button} from '@/components/ui/button';
import {useAgentTarget} from '@/hooks/use-agent-target';
import {allows, describeActions, displayValue, recordTitle} from '@/lib/access';
import type {agentCollectionLoader} from '@/agent-loaders';

// What a record page hands over when its record left the collection: "Sent draft “Re: Q3”".
function noticeFromState(state: unknown): string | null {
	if (typeof state !== 'object' || state === null || !('notice' in state)) {
		return null;
	}
	return typeof state.notice === 'string' ? state.notice : null;
}

// A collection's records, with New when the agent may create one.
export function AgentCollectionPage() {
	const outcome = useLoaderData<typeof agentCollectionLoader>();
	const notice = noticeFromState(useLocation().state);
	const target = useAgentTarget();
	if (outcome.kind === 'denied') {
		return <AgentDenied>This login has no access to this collection.</AgentDenied>;
	}

	if (outcome.kind === 'missing' || !target) {
		return <AgentMissing />;
	}

	const {connection, integration, collection} = target;
	const {actions, records} = outcome.value;
	const summary = collection.fields.find((field) => field.key === collection.summaryField);
	const base = `/agent/${connection.id}/${collection.id}`;

	return (
		<AgentShell>
			<Crumbs
				items={[{label: 'Home', to: '/agent'}, {label: integration.name}, {label: collection.name}]}
			/>
			<div className="mb-4 flex items-center justify-between gap-4 md:px-3">
				<AgentHeading detail={describeActions(collection, actions)}>{collection.name}</AgentHeading>
				{allows(collection, actions, 'create') && (
					<Button size="sm" nativeButton={false} render={<Link to={`${base}/new`} />}>
						New {collection.singular}
					</Button>
				)}
			</div>
			{notice && <p className="mb-4 text-sm md:px-3">{notice}.</p>}
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

// What an agent sees when it asks for something it was not given. The api logged the request as
// denied.
export function AgentDenied({children}: {children: ReactNode}) {
	return (
		<AgentShell>
			<Crumbs items={[{label: 'Home', to: '/agent'}, {label: 'No access'}]} />
			<p className="text-sm md:px-3">{children} Ask the person who made it to give it access.</p>
		</AgentShell>
	);
}
