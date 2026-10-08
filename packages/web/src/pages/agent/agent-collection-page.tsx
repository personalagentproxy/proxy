import type {ReactNode} from 'react';
import {Form, Link, useLoaderData, useLocation, useSearchParams} from 'react-router';
import {AgentHeading, AgentShell, Crumbs} from '@/components/agent-shell';
import {EmptyRows, Row, RowList} from '@/components/row-list';
import {Button} from '@proxy/ui/components/button';
import {Input} from '@proxy/ui/components/input';
import {useAgentTarget} from '@/hooks/use-agent-target';
import {canStartNew, displayValue, recordTitle} from '@/lib/access';
import {inside} from '@/lib/agent-paths';
import type {agentCollectionLoader} from '@/agent-loaders';

// What a page hands over when its record left the list, or was sent: "Sent email “Re: Q3”".
export function noticeFromState(state: unknown): string | null {
	if (typeof state !== 'object' || state === null || !('notice' in state)) {
		return null;
	}
	return typeof state.notice === 'string' ? state.notice : null;
}

// A collection's records, a page at a time, newest first, with a search where the collection has
// one, and with New when the agent may start one. A collection with a filter field, such as an
// email's folder, can be narrowed to one of its values, and each row says which it has. In a nested
// collection the list can be opened inside a record, `?parent=`, and says where it is: a record
// holding others opens into them, and New makes one there. The search, the filter, the parent and
// the page are in the address, so every page can be linked to. An agent that can only add here, as
// one that may send but not read email, gets New alone.
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
	const parent = params.get('parent');
	const trail = outcome.kind === 'ok' ? (outcome.value.trail ?? []) : [];
	const here = trail.at(-1);
	const header = (
		<>
			<Crumbs
				items={[
					{label: 'Home', to: '/agent'},
					{label: place},
					{label: collection.name, to: parent ? base : undefined},
					...trail.map((crumb) => ({
						label: crumb.title,
						to: crumb === here ? undefined : `${base}${inside(crumb.id)}`,
					})),
				]}
			/>
			<div className="mb-4 flex items-center justify-between gap-4 md:px-3">
				<AgentHeading>{here?.title ?? collection.name}</AgentHeading>
				<div className="flex gap-2">
					{here && (
						<Button
							size="sm"
							variant="outline"
							nativeButton={false}
							render={<Link to={`${base}/${here.id}`} />}
						>
							Open “{here.title}” itself
						</Button>
					)}
					{canStartNew(collection, actions) && (
						<Button
							size="sm"
							nativeButton={false}
							render={
								<Link to={`${base}/new${inside(parent)}`} state={{parentTitle: here?.title}} />
							}
						>
							New {collection.singular}
							{here ? ' here' : ''}
						</Button>
					)}
				</div>
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
	// The filter is in the address under its field's key, as the list tool takes it: `?folder=Draft`.
	const chosen = filter ? params.get(filter.key) : null;
	const {records, nextPage} = outcome.value;
	// A list's address: in the same place, the search and the filter as they are, on the first page
	// unless given one.
	const listLink = (changes: {search?: null; filter?: string | null; page?: string}) => {
		const next = new URLSearchParams();
		const value = changes.filter === undefined ? chosen : changes.filter;
		if (parent) {
			next.set('parent', parent);
		}
		if (search && changes.search !== null) {
			next.set('search', search);
		}
		if (filter && value) {
			next.set(filter.key, value);
		}
		if (changes.page) {
			next.set('page', changes.page);
		}
		return next.size > 0 ? `${base}?${next}` : base;
	};

	return (
		<AgentShell>
			{header}
			{collection.searchHint && (
				<>
					<Form method="get" className="mb-1 flex gap-2 md:px-3">
						{filter && chosen && <input type="hidden" name={filter.key} value={chosen} />}
						{parent && <input type="hidden" name="parent" value={parent} />}
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
								render={<Link to={listLink({search: null})} />}
							>
								Clear search
							</Button>
						)}
					</Form>
					<p className="mb-4 text-sm text-muted-foreground md:px-3">{collection.searchHint}</p>
				</>
			)}
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
						{search
							? `Nothing matches “${search}”.`
							: `No ${collection.name.toLowerCase()}${here ? ' in here' : ''}.`}
					</EmptyRows>
				)}
				{records.map((record) => (
					<Row
						key={record.id}
						to={record.hasChildren ? `${base}${inside(record.id)}` : `${base}/${record.id}`}
						title={recordTitle(collection, record)}
						cells={
							<>
								{record.hasChildren && (
									<span className="shrink-0 text-muted-foreground">Has more inside</span>
								)}
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
