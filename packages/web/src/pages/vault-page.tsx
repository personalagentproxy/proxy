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
import {useLoaderData, useRevalidator} from 'react-router';
import type {Result} from 'ts-results-es';
import {createRecord, deleteRecord, updateRecord} from '@/client/records-client';
import {AppShell, PageTitle} from '@/components/app-shell';
import {RecordForm} from '@/components/record-form';
import {EmptyRows, Row, RowHeader, RowList} from '@/components/row-list';
import {Badge} from '@proxy/ui/components/badge';
import {Button} from '@proxy/ui/components/button';
import {Dialog, DialogContent, DialogHeader, DialogTitle} from '@proxy/ui/components/dialog';
import {recordTitle} from '@/lib/access';
import {findIntegration} from '@/lib/integrations';
import {describeFetchError} from '@/lib/loader-utils';
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

// Which entry the dialog is open on: a new one, or one being edited.
type Editing = {entry: DataRecord | null};

// What the person's agents should know about them, kept by the person or by the agents: a table of
// the entries, each opened for editing.
export function VaultPage() {
	const org = useOrgSlug();
	const {connectionId, entries} = useLoaderData<typeof vaultLoader>();
	const revalidator = useRevalidator();
	const [editing, setEditing] = useState<Editing | null>(null);
	const [error, setError] = useState<string | null>(null);
	const vault = findIntegration(VAULT_INTEGRATION_ID);
	const collection = vault && findCollection(vault, ENTRIES);
	if (!collection) {
		return null;
	}

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
				<Button size="sm" variant="outline" onClick={() => open({entry: null})}>
					<PlusIcon data-icon="inline-start" />
					Add entry
				</Button>
			}
		>
			<RowList
				header={
					<RowHeader>
						<span className="min-w-0 flex-1">Title</span>
						<span className={CELLS.type}>Type</span>
						<span className={CELLS.content}>Content</span>
					</RowHeader>
				}
			>
				{entries.length === 0 && (
					<EmptyRows>
						Nothing yet. Add what your agents should know about you, or let them keep what they
						learn.
					</EmptyRows>
				)}
				{entries.map((entry) => (
					<Row
						key={entry.id}
						onClick={() => open({entry})}
						title={recordTitle(collection, entry)}
						cells={
							<>
								<span className={CELLS.type}>
									<TypeBadge type={entry.values.type || 'Text'} />
								</span>
								<span className={CELLS.content}>{entry.values.content?.split('\n')[0]}</span>
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
								{editing.entry ? recordTitle(collection, editing.entry) : 'New entry'}
							</DialogTitle>
						</DialogHeader>
						<RecordForm
							fields={collection.fields}
							initial={editing.entry?.values ?? {type: 'Text'}}
							submitLabel="Save"
							requireNonEmpty={editing.entry === null}
							onCancel={() => open(null)}
							onSubmit={(values) => {
								const {entry} = editing;
								void apply(
									entry
										? updateRecord(org, connectionId, ENTRIES, entry.id, values)
										: createRecord(org, connectionId, ENTRIES, values),
								);
							}}
							extra={
								editing.entry && (
									<Button
										type="button"
										variant="destructive"
										onClick={() => {
											const {entry} = editing;
											if (entry) {
												void apply(deleteRecord(org, connectionId, ENTRIES, entry.id));
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
