import type {ReactNode} from 'react';
import {Form, Link, useLoaderData, useLocation, useSearchParams} from 'react-router';
import {AgentHeading, AgentShell, Crumbs} from '@/components/agent-shell';
import {EmptyRows, Row, RowList} from '@/components/row-list';
import {Button} from '@proxy/ui/components/button';
import {Input} from '@proxy/ui/components/input';
import {useAgentTarget} from '@/hooks/use-agent-target';
import {canStartNew, displayValue, recordTitle} from '@/lib/access';
import type {agentCollectionLoader} from '@/agent-loaders';

// What a page hands over when its record left the list, or was sent: "Sent email “Re: Q3”".
export function noticeFromState(state: unknown): string | null {
	if (typeof state !== 'object' || state === null || !('notice' in state)) {
		return null;
	}
	return typeof state.notice === 'string' ? state.notice : null;
}

// A collection's records, a page at a time, newest first, with a search, and with New when the
// agent may start one. A collection with a filter field, such as an email's folder, can be narrowed
// to one of its values, and each row says which it has. The search, the filter and the page are in
// the address, so every page can be linked to. An agent that can only add here, as one that may
// send but not read email, gets New alone.
export function AgentCollectionPage() {
	const outcome = useLoaderData<typeof agentCollectionLoader>();
	const notice = noticeFromState(useLocation().state);
	const [params] = useSearchParams();
	const target = useAgentTarget();
	if (outcome.kind === 'missing' || !target) {
		return <AgentMissing />;
	}

	const {connection, collection, place, actions} = target;
	const base = `/agent/${connection.id}/${collection.id}`;
	const header = (
		<>
			<Crumbs items={[{label: 'Home', to: '/agent'}, {label: place}, {label: collection.name}]} />
			<div className="mb-4 flex items-center justify-between gap-4 md:px-3">
				<AgentHeading>{collection.name}</AgentHeading>
				{canStartNew(collection, actions) && (
					<Button size="sm" nativeButton={false} render={<Link to={`${base}/new`} />}>
						New {collection.singular}
					</Button>
				)}
			</div>
			{notice && <p className="mb-4 text-sm md:px-3">{notice}.</p>}
		</>
	);
	if (outcome.kind === 'denied' && canStartNew(collection, actions)) {
		return (
			<AgentShell>
				{header}
				<p className="text-sm text-muted-foreground md:px-3">
					This login can add {collection.name.toLowerCase()} here but not read it.
				</p>
			</AgentShell>
		);
	}

	if (outcome.kind === 'denied') {
		return <AgentDenied>This login has no access to this collection.</AgentDenied>;
	}

	const summary = collection.fields.find((field) => field.key === collection.summaryField);
	const filter = collection.fields.find((field) => field.key === collection.filterField);
	const search = params.get('search') ?? '';
	const chosen = params.get('filter');
	const {records, nextPage} = outcome.value;
	// A list's address: the search and the filter as they are, on the first page unless given one.
	const listLink = (changes: {filter?: string | null; page?: string}) => {
		const next = new URLSearchParams();
		const value = changes.filter === undefined ? chosen : changes.filter;
		if (search) {
			next.set('search', search);
		}
		if (value) {
			next.set('filter', value);
		}
		if (changes.page) {
			next.set('page', changes.page);
		}
		return next.size > 0 ? `${base}?${next}` : base;
	};

	return (
		<AgentShell>
			{header}
			<Form method="get" className="mb-1 flex gap-2 md:px-3">
				{chosen && <input type="hidden" name="filter" value={chosen} />}
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
					<Button
						variant="ghost"
						nativeButton={false}
						render={<Link to={chosen ? `${base}?filter=${chosen}` : base} />}
					>
						Clear search
					</Button>
				)}
			</Form>
			<p className="mb-4 text-sm text-muted-foreground md:px-3">{collection.searchHint}</p>
			{filter && (
				<nav aria-label={`${filter.label} filter`} className="mb-3 flex gap-1 md:px-3">
					{[null, ...(filter.options ?? [])].map((option) => (
						<Button
							key={option ?? 'all'}
							size="sm"
							variant={chosen === option ? 'secondary' : 'ghost'}
							nativeButton={false}
							render={<Link to={listLink({filter: option})} />}
						>
							{option ?? 'All'}
						</Button>
					))}
				</nav>
			)}
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
							<>
								{summary && (
									<span className="max-w-[40%] shrink-0 truncate text-muted-foreground">
										{displayValue(summary.type, record.values[summary.key])}
									</span>
								)}
								{filter && !chosen && (
									<span className="w-12 shrink-0 text-right text-muted-foreground">
										{record.values[filter.key]}
									</span>
								)}
							</>
						}
					/>
				))}
			</RowList>
			{nextPage && (
				<div className="mt-4 md:px-3">
					<Button
						variant="outline"
						nativeButton={false}
						render={<Link to={listLink({page: nextPage})} />}
					>
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
