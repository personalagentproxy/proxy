import {findCollection, VAULT_INTEGRATION_ID} from '@proxy/integrations';
import type {FetchError} from '@proxy/utils';
import {
	CalendarIcon,
	LinkIcon,
	MailIcon,
	MapPinIcon,
	PhoneIcon,
	PlusIcon,
	TextIcon,
	type LucideIcon,
} from 'lucide-react';
import {useState} from 'react';
import {useLoaderData, useRevalidator, useSearchParams} from 'react-router';
import type {Result} from 'ts-results-es';
import {createRecord, deleteRecord, updateRecord} from '@/client/records-client';
import {AppShell, PageTitle} from '@/components/app-shell';
import {RecordForm} from '@/components/record-form';
import {EmptyRows, Row, RowHeader, RowList} from '@/components/row-list';
import {ShareToggle} from '@/components/share-toggle';
import {Badge} from '@proxy/ui/components/badge';
import {Button} from '@proxy/ui/components/button';
import {Dialog, DialogContent, DialogHeader, DialogTitle} from '@proxy/ui/components/dialog';
import {useHuman} from '@/hooks/use-human';
import {recordTitle} from '@/lib/access';
import {findIntegration} from '@/lib/integrations';
import {describeFetchError} from '@/lib/loader-utils';
import {hasOtherPeople} from '@/lib/orgs';
import type {DataRecord} from '@/lib/types';
import type {vaultLoader} from '@/loaders';
import {useOrgSlug} from '@/hooks/use-org';

const ENTRIES = 'entries';

// The table's columns after the title, the header's and the rows' alike: the content only on
// screens wide enough for it.
const CELLS = {
	type: 'w-36 shrink-0',
	content: 'hidden w-2/5 shrink-0 truncate text-muted-foreground md:block',
};

// Each of the catalog's VAULT_ENTRY_TYPES, as its badge shows it.
const TYPE_ICONS: Record<string, LucideIcon> = {
	Text: TextIcon,
	Address: MapPinIcon,
	'Phone number': PhoneIcon,
	Email: MailIcon,
	Link: LinkIcon,
	Date: CalendarIcon,
};

function TypeBadge({type}: {type: string}) {
	const Icon = TYPE_ICONS[type] ?? TextIcon;
	return (
		<Badge variant="secondary" className="font-normal">
			<Icon data-icon="inline-start" />
			{type}
		</Badge>
	);
}

// An entry with the vault it is in, since the page lists the entries of two.
type Listed = {entry: DataRecord; connectionId: string};

// Which entry the dialog is open on: a new one, in the vault shown, or one being edited.
type Editing = {listed: Listed | null};

// What the person's agents should know about them, kept by the person or by the agents, and what
// everyone's agents should know about the organization: a table of the entries, each opened for
// editing. With anyone else in the organization or invited, a toggle picks the vault, the person's
// own or the organization's, in the address as `?for=me` or `?for=everyone`, opening on their own;
// alone, both vaults' entries are one list, and a new entry is the person's own.
export function VaultPage() {
	const org = useOrgSlug();
	const {own, shared} = useLoaderData<typeof vaultLoader>();
	const revalidator = useRevalidator();
	const [params, setParams] = useSearchParams();
	const human = useHuman();
	const [editing, setEditing] = useState<Editing | null>(null);
	const [error, setError] = useState<string | null>(null);
	const vault = findIntegration(VAULT_INTEGRATION_ID);
	const collection = vault && findCollection(vault, ENTRIES);
	if (!collection || !human) {
		return null;
	}

	const activeOrg = human.org;
	const others = hasOtherPeople(activeOrg);
	const showingShared = others && params.get('for') === 'everyone';
	const list = (vault: {connectionId: string; entries: DataRecord[]}): Listed[] =>
		vault.entries.map((entry) => ({entry, connectionId: vault.connectionId}));
	const shown = showingShared ? shared : own;
	const listed = others ? list(shown) : [...list(own), ...list(shared)];

	const open = (next: Editing | null) => {
		setError(null);
		setEditing(next);
	};
	// Closes the dialog once the change is saved; a failure keeps it open, saying what went wrong.
	const apply = async <T,>(change: Promise<Result<T, FetchError>>) => {
		const result = await change;
		if (result.isErr()) {
			setError(describeFetchError(result.error));
			return;
		}
		open(null);
		await revalidator.revalidate();
	};

	return (
		<AppShell
			title={<PageTitle>Vault</PageTitle>}
			actions={
				<Button size="sm" variant="outline" onClick={() => open({listed: null})}>
					<PlusIcon data-icon="inline-start" />
					Add entry
				</Button>
			}
		>
			{others && (
				<ShareToggle
					orgName={activeOrg.name}
					shared={showingShared}
					counts={{shared: shared.entries.length, yours: own.entries.length}}
					onChange={(next) => setParams({for: next ? 'everyone' : 'me'}, {replace: true})}
				/>
			)}
			<RowList
				header={
					<RowHeader>
						<span className="min-w-0 flex-1">Title</span>
						<span className={CELLS.type}>Type</span>
						<span className={CELLS.content}>Content</span>
					</RowHeader>
				}
			>
				{listed.length === 0 && !showingShared && (
					<EmptyRows>
						Nothing yet. Add what your agents should know about you, or let them keep what they
						learn.
					</EmptyRows>
				)}
				{listed.length === 0 && showingShared && (
					<EmptyRows>
						Nothing yet. Add what everyone's agents should know about {activeOrg.name}, or let them
						keep what they learn.
					</EmptyRows>
				)}
				{listed.map((item) => (
					<Row
						key={item.entry.id}
						onClick={() => open({listed: item})}
						title={recordTitle(collection, item.entry)}
						cells={
							<>
								<span className={CELLS.type}>
									<TypeBadge type={item.entry.values.type || 'Text'} />
								</span>
								<span className={CELLS.content}>{item.entry.values.content?.split('\n')[0]}</span>
							</>
						}
					/>
				))}
			</RowList>
			<Dialog
				open={editing !== null}
				onOpenChange={(next) => {
					if (next) {
						return;
					}
					open(null);
				}}
			>
				{editing && (
					<DialogContent>
						<DialogHeader>
							<DialogTitle>
								{editing.listed ? recordTitle(collection, editing.listed.entry) : 'New entry'}
							</DialogTitle>
						</DialogHeader>
						<RecordForm
							fields={collection.fields}
							initial={editing.listed?.entry.values ?? {type: 'Text'}}
							submitLabel="Save"
							requireNonEmpty={editing.listed === null}
							onCancel={() => open(null)}
							onSubmit={(values) => {
								const {listed: item} = editing;
								void apply(
									item
										? updateRecord(org, item.connectionId, ENTRIES, item.entry.id, values)
										: createRecord(org, shown.connectionId, ENTRIES, values),
								);
							}}
							extra={
								editing.listed && (
									<Button
										type="button"
										variant="destructive"
										onClick={() => {
											const {listed: item} = editing;
											if (item) {
												void apply(deleteRecord(org, item.connectionId, ENTRIES, item.entry.id));
											}
										}}
									>
										Delete
									</Button>
								)
							}
						/>
						{error && <p className="text-sm text-destructive">{error}</p>}
					</DialogContent>
				)}
			</Dialog>
		</AppShell>
	);
}
