import type {DataRecord} from '@proxy/contracts/records';
import {findCollection, VAULT_INTEGRATION_ID} from '@proxy/integrations';
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
import {useLoaderData} from 'react-router';
import {createRecord, deleteRecord, updateRecord} from '@/client/records-client';
import {AppShell, PageTitle} from '@/components/app-shell';
import {BackButton} from '@/components/back-button';
import {RecordForm} from '@/components/record-form';
import {Row, RowHeader, RowList} from '@/components/row-list';
import {SideEmpty, SideToggle} from '@/components/share-toggle';
import {Badge} from '@proxy/ui/components/badge';
import {Button} from '@proxy/ui/components/button';
import {Dialog, DialogContent, DialogHeader, DialogTitle} from '@proxy/ui/components/dialog';
import {useApply} from '@/hooks/use-apply';
import {useHuman} from '@/hooks/use-human';
import {useSide} from '@/hooks/use-side';
import {recordTitle} from '@/lib/access';
import {findIntegration} from '@/lib/integrations';
import type {vaultLoader} from '@/loaders';
import {useOrgSlug} from '@/hooks/use-org';

const ENTRIES = 'entries';

const OWN_EMPTY =
	'Nothing yet. Add what your agents should know about you, or let them keep what they learn.';

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
type Listed = {entry: DataRecord; connectionId: string; shared: boolean};

// Which entry the dialog is open on: a new one, in the vault shown, or one being edited.
type Editing = {listed: Listed | null};

// What the person's agents should know about them, kept by the person or by the agents, and what
// everyone's agents should know about the organization: a table of the entries, each opened for
// editing. With anyone else in the organization or invited, a toggle picks the vault, the person's
// own or the organization's, in the address as `?for=me` or `?for=everyone`, opening on their own;
// alone, both vaults' entries are one list, and a new entry is the person's own. It is one of the
// connections, opened from theirs.
export function VaultPage() {
	const org = useOrgSlug();
	const {own, shared} = useLoaderData<typeof vaultLoader>();
	const human = useHuman();
	const [editing, setEditing] = useState<Editing | null>(null);
	const [error, setError] = useState<string | null>(null);
	const apply = useApply(setError);
	const list = (kept: {connectionId: string; entries: DataRecord[]}, inShared: boolean): Listed[] =>
		kept.entries.map((entry) => ({entry, connectionId: kept.connectionId, shared: inShared}));
	const side = useSide([...list(own, false), ...list(shared, true)], {opensOnShared: false});
	const vault = findIntegration(VAULT_INTEGRATION_ID);
	const collection = vault && findCollection(vault, ENTRIES);
	if (!collection || !human) {
		return null;
	}

	const activeOrg = human.org;
	const listed = side.shown;
	// Where a new entry goes: the vault shown, the person's own when alone.
	const shown = side.shared ? shared : own;

	const open = (next: Editing | null) => {
		setError(null);
		setEditing(next);
	};
	// Closes the dialog once the change is saved; a failure keeps it open, saying what went wrong.
	const close = () => setEditing(null);

	return (
		<AppShell
			title={
				<>
					<BackButton to={`/${org}/connections`} label="Back to connections" />
					<PageTitle>Vault</PageTitle>
				</>
			}
			actions={
				<Button size="sm" variant="outline" onClick={() => open({listed: null})}>
					<PlusIcon data-icon="inline-start" />
					Add entry
				</Button>
			}
		>
			<SideToggle side={side} orgName={activeOrg.name} />
			<RowList
				header={
					<RowHeader>
						<span className="min-w-0 flex-1">Title</span>
						<span className={CELLS.type}>Type</span>
						<span className={CELLS.content}>Content</span>
					</RowHeader>
				}
			>
				{listed.length === 0 && (
					<SideEmpty
						side={side}
						alone={OWN_EMPTY}
						shared={`Nothing yet. Add what everyone's agents should know about ${activeOrg.name}, or let them keep what they learn.`}
						own={OWN_EMPTY}
					/>
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
									close,
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
												void apply(
													deleteRecord(org, item.connectionId, ENTRIES, item.entry.id),
													close,
												);
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
