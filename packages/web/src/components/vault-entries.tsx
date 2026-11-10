import type {DataRecord} from '@proxy/contracts/records';
import {findCollection, VAULT_INTEGRATION_ID} from '@proxy/integrations';
import {
	CalendarIcon,
	LinkIcon,
	MailIcon,
	MapPinIcon,
	PhoneIcon,
	TextIcon,
	type LucideIcon,
} from 'lucide-react';
import {useState} from 'react';
import {createRecord, deleteRecord, updateRecord} from '@/client/records-client';
import {AddButton} from '@/components/add-button';
import {RecordForm} from '@/components/record-form';
import {EmptyRows, Row, RowHeader, RowList} from '@/components/row-list';
import {Badge} from '@proxy/ui/components/badge';
import {Button} from '@proxy/ui/components/button';
import {Dialog, DialogContent, DialogHeader, DialogTitle} from '@proxy/ui/components/dialog';
import {useApply} from '@/hooks/use-apply';
import {recordTitle} from '@/lib/access';
import {findIntegration} from '@/lib/integrations';
import {useOrgSlug} from '@/hooks/use-org';

const ENTRIES = 'entries';

const OWN_EMPTY =
	'Nothing yet. Add what your agents should know about you, or let them keep what they learn.';
const MADE_EMPTY =
	'Nothing yet. Add what the agents of everyone who uses this vault should know, or let them keep what they learn.';

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

type Props = {
	// The vault's connection.
	connectionId: string;
	entries: DataRecord[];
	// A vault a member made, for more than their own agents, rather than the person's own.
	made: boolean;
};

// The Entries part of a vault's page, the first of its connection's tabs: what the person's
// agents should know about them, kept by the person or by the agents, in their own vault, or what
// more than their own agents should know, in one a member made: a table of the entries, each
// opened for editing, with a button that adds one.
export function VaultEntries({connectionId, entries, made}: Props) {
	const org = useOrgSlug();
	const [editing, setEditing] = useState<Editing | null>(null);
	const [error, setError] = useState<string | null>(null);
	const apply = useApply(setError);
	const integration = findIntegration(VAULT_INTEGRATION_ID);
	const collection = integration && findCollection(integration, ENTRIES);
	if (!collection) {
		return null;
	}

	const open = (next: Editing | null) => {
		setError(null);
		setEditing(next);
	};
	// Closes the dialog once the change is saved; a failure keeps it open, saying what went wrong.
	const close = () => setEditing(null);

	return (
		<div className="flex flex-col gap-2">
			<div className="flex min-h-8 items-center justify-between gap-4 text-sm text-muted-foreground">
				<span>
					{made
						? 'What the agents of everyone who uses this vault should know'
						: 'What your agents should know about you'}
				</span>
				<AddButton label="Add entry" variant="outline" onClick={() => open({entry: null})} />
			</div>
			<RowList
				header={
					<RowHeader>
						<span className="min-w-0 flex-1">Title</span>
						<span className={CELLS.type}>Type</span>
						<span className={CELLS.content}>Content</span>
					</RowHeader>
				}
			>
				{entries.length === 0 && <EmptyRows>{made ? MADE_EMPTY : OWN_EMPTY}</EmptyRows>}
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
									close,
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
												void apply(deleteRecord(org, connectionId, ENTRIES, entry.id), close);
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
		</div>
	);
}
