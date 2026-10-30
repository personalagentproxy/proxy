import type {Collection} from '@proxy/integrations';
import type {ReactNode} from 'react';
import {Form, Link, useLoaderData, useLocation, useSearchParams} from 'react-router';
import {
	AgentHeading,
	AgentShell,
	Crumbs,
	OpenInLink,
	PersonLinkHint,
} from '@/components/agent-shell';
import {EmptyRows, Row, RowList} from '@/components/row-list';
import {Button} from '@proxy/ui/components/button';
import {Input} from '@proxy/ui/components/input';
import {useAgentTarget} from '@/hooks/use-agent-target';
import {canStartNew, displayValue, recordTitle} from '@/lib/access';
import {useTaskId} from '@/hooks/use-task-id';
import {taskHome} from '@/lib/agent-task';
import {inside, recordPath} from '@/lib/agent-paths';
import type {agentCollectionLoader} from '@/agent-loaders';
import type {DataRecord} from '@/lib/types';

// What a page hands over when its record left the list, or was sent: "Sent email “Re: Q3”".
export function noticeFromState(state: unknown): string | null {
	if (typeof state !== 'object' || state === null || !('notice' in state)) {
		return null;
	}
	return typeof state.notice === 'string' ? state.notice : null;
}

// A collection's records, a page at a time, newest first, or soonest first from now on for an
// upcoming one such as a calendar's events, with a search where the collection has one, and with New when the agent may start one. A collection with a filter field, such as an
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
	const home = taskHome(useTaskId());
	if (outcome.kind === 'missing' || !target) {
		return <AgentMissing />;
	}

	const {connection, collection, place, actions} = target;
	const base = `${home}/${connection.id}/${collection.id}`;
	const parent = params.get('parent');
	const trail = outcome.kind === 'ok' ? (outcome.value.trail ?? []) : [];
	const here = trail.at(-1);
	const header = (
		<>
			<Crumbs
				items={[
					{label: 'Home', to: home},
					{label: place},
					{label: collection.name, to: parent ? base : undefined},
					...trail.map((crumb) => ({
						label: crumb.title,
						to: crumb === here ? undefined : `${base}${inside(crumb.id)}`,
					})),
				]}
			/>
			<div className="flex items-center justify-between gap-4">
				<AgentHeading>{here?.title ?? collection.name}</AgentHeading>
				<div className="flex gap-2">
					{here && (
						<Button
							size="sm"
							variant="outline"
							nativeButton={false}
							render={<Link to={recordPath(base, here.id)} />}
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
			{notice && <p className="text-sm">{notice}.</p>}
		</>
	);
	if (outcome.kind === 'denied' && canStartNew(collection, actions)) {
		return (
			<AgentShell>
				{header}
				<p className="text-sm text-muted-foreground">
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
			<PersonLinkHint collection={collection} />
			{collection.searchHint && (
				<div className="flex flex-col gap-1">
					<Form method="get" className="flex gap-2">
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
					<p className="text-sm text-muted-foreground">{collection.searchHint}</p>
				</div>
			)}
			{filter && (
				<nav aria-label={`${filter.label} filter`} className="flex gap-1">
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
						to={record.hasChildren ? `${base}${inside(record.id)}` : recordPath(base, record.id)}
						title={recordTitle(collection, record)}
						subtitle={
							collection.listsAll && <RecordFieldsLine collection={collection} record={record} />
						}
						after={
							record.url && (
								<OpenInLink
									collection={collection}
									url={record.url}
									className="text-sm text-muted-foreground"
								/>
							)
						}
						cells={
							!collection.listsAll && (
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
										<span className="w-20 shrink-0 text-right text-muted-foreground">
											{record.values[filter.key]}
										</span>
									)}
								</>
							)
						}
					/>
				))}
			</RowList>
			{nextPage && (
				<Button
					variant="outline"
					className="self-start"
					nativeButton={false}
					render={<Link to={listLink({page: nextPage})} />}
				>
					{collection.upcoming ? 'Later' : 'Older'} {collection.name.toLowerCase()}
				</Button>
			)}
		</AgentShell>
	);
}

export function AgentMissing() {
	const home = taskHome(useTaskId());
	return (
		<AgentShell>
			<Crumbs items={[{label: 'Home', to: home}, {label: 'Not found'}]} />
			<p className="text-sm text-muted-foreground">There is nothing at this address.</p>
		</AgentShell>
	);
}

// What an agent sees when it asks for something it was not given. The api logged the request as
// denied.
export function AgentDenied({children}: {children: ReactNode}) {
	const home = taskHome(useTaskId());
	return (
		<AgentShell>
			<Crumbs items={[{label: 'Home', to: home}, {label: 'No access'}]} />
			<p className="text-sm">{children} Ask the person who made it to give it access.</p>
		</AgentShell>
	);
}

// Every field the record has but its title, "Label: value" one after another, under the title of
// a row in a `listsAll` collection, so an agent reads the whole record from the list without
// opening it. A day is written as it is, 2026-10-11, its year and all.
function RecordFieldsLine({collection, record}: {collection: Collection; record: DataRecord}) {
	const fields = collection.fields.filter(
		(field) => field.key !== collection.titleField && record.values[field.key],
	);
	return (
		<>
			{fields.map((field, index) => (
				<span key={field.key}>
					{index > 0 && ' · '}
					{field.label}:{' '}
					{field.type === 'date'
						? record.values[field.key]
						: displayValue(field.type, record.values[field.key])}
				</span>
			))}
			{record.hasChildren && (fields.length > 0 ? ' · Has more inside' : 'Has more inside')}
		</>
	);
}
