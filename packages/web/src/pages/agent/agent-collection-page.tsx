import {allowsWrite} from '@proxy/integrations';
import type {ReactNode} from 'react';
import {Form, Link, useLoaderData, useSearchParams} from 'react-router';
import {AgentHeading, AgentShell, Crumbs} from '@/components/agent-shell';
import {EmptyRows, Row, RowList} from '@/components/row-list';
import {Button} from '@proxy/ui/components/button';
import {Input} from '@proxy/ui/components/input';
import {useAgentTarget} from '@/hooks/use-agent-target';
import {agentAccessLabel, displayValue, recordTitle} from '@/lib/access';
import type {agentCollectionLoader} from '@/agent-loaders';

// A collection's records, a page at a time, newest first, with a search and with New when the
// agent may write. The search and the page are in the address, so every page can be linked to.
export function AgentCollectionPage() {
	const outcome = useLoaderData<typeof agentCollectionLoader>();
	const target = useAgentTarget();
	const [params] = useSearchParams();
	const search = params.get('search') ?? '';
	if (outcome.kind === 'denied') {
		return <AgentDenied>This login has no access to this collection.</AgentDenied>;
	}

	if (outcome.kind === 'missing' || !target) {
		return <AgentMissing />;
	}

	const {connection, integration, collection} = target;
	const {access, records, nextPage} = outcome.value;
	const summary = collection.fields.find((field) => field.key === collection.summaryField);
	const base = `/agent/${connection.id}/${collection.id}`;
	const olderLink = nextPage
		? `${base}?${new URLSearchParams(search ? {search, page: nextPage} : {page: nextPage})}`
		: null;

	return (
		<AgentShell>
			<Crumbs
				items={[{label: 'Home', to: '/agent'}, {label: integration.name}, {label: collection.name}]}
			/>
			<div className="mb-4 flex items-center justify-between gap-4 md:px-3">
				<AgentHeading detail={agentAccessLabel(collection, access)}>{collection.name}</AgentHeading>
				{access === 'write' && allowsWrite(collection, 'create') && (
					<Button size="sm" nativeButton={false} render={<Link to={`${base}/new`} />}>
						{collection.createVerb?.present ?? 'New'} {collection.singular}
					</Button>
				)}
			</div>
			<Form method="get" className="mb-4 flex gap-2 md:px-3">
				<Input
					name="search"
					aria-label={`Search ${collection.name.toLowerCase()}`}
					placeholder={`Search ${collection.name.toLowerCase()}`}
					defaultValue={search}
					key={search}
				/>
				<Button type="submit" variant="outline">
					Search
				</Button>
				{search && (
					<Button variant="ghost" nativeButton={false} render={<Link to={base} />}>
						Clear search
					</Button>
				)}
			</Form>
			<RowList>
				{records.length === 0 && (
					<EmptyRows>
						{search ? `Nothing matches “${search}”.` : `No ${collection.name.toLowerCase()}.`}
					</EmptyRows>
				)}
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
			{olderLink && (
				<div className="mt-4 md:px-3">
					<Button variant="outline" nativeButton={false} render={<Link to={olderLink} />}>
						Older {collection.name.toLowerCase()}
					</Button>
				</div>
			)}
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
