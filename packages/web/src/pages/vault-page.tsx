import type {Connection} from '@proxy/contracts/connections';
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
import {Link, useLoaderData} from 'react-router';
import {createRecord, deleteRecord, updateRecord} from '@/client/records-client';
import {AppShell, PageTitle} from '@/components/app-shell';
import {AddButton} from '@/components/add-button';
import {NotFound} from '@/components/not-found';
import {RecordForm} from '@/components/record-form';
import {EmptyRows, Row, RowHeader, RowList} from '@/components/row-list';
import {Badge} from '@proxy/ui/components/badge';
import {Button} from '@proxy/ui/components/button';
import {Dialog, DialogContent, DialogHeader, DialogTitle} from '@proxy/ui/components/dialog';
import {useApply} from '@/hooks/use-apply';
import {useHuman} from '@/hooks/use-human';
import {connectionTitle, recordTitle} from '@/lib/access';
import {ownerOf} from '@/lib/orgs';
import {findIntegration} from '@/lib/integrations';
import type {vaultLoader} from '@/loaders';
import {useOrgSlug} from '@/hooks/use-org';

const ENTRIES = 'entries';

const OWN_EMPTY =
	'Nothing yet. Add what your agents should know about you, or let them keep what they learn.';
const MADE_EMPTY =
	'Nothing yet. Add what the agents of everyone who uses this vault should know, or let them keep what they learn.';

// "shared with everyone in Acme", "shared with Dana and Sam", or "shared with nobody yet".
function sharedWith(connection: Connection, orgName: string): string {
	if (connection.sharedWithEveryone) {
		return `shared with everyone in ${orgName}`;
	}
	const names = connection.sharedWith.map((member) => member.name);
	if (names.length === 0) {
		return 'shared with nobody yet';
	}
	return `shared with ${new Intl.ListFormat('en', {type: 'conjunction'}).format(names)}`;
}

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

// Which entry the dialog is open on: a new one, in the vault shown, or one being edited.
type Editing = {entry: DataRecord | null};

// One vault: what the person's agents should know about them, kept by the person or by the
// agents, in their own, or what more than their own agents should know, in one a member made: a
// table of its entries, each opened for editing, under what the vault is called, "My vault" or
// the name it was given. The person's own is at `connections/vault`; one a member made has its page
// under that, by its connection, and says whose it is and who it is shared with, with a link to its connection's page, where that is set. Each is
// one of the connections, opened from theirs.
export function VaultPage() {
	const org = useOrgSlug();
	const {vault, entries} = useLoaderData<typeof vaultLoader>();
	const human = useHuman();
	const [editing, setEditing] = useState<Editing | null>(null);
	const [error, setError] = useState<string | null>(null);
	const apply = useApply(setError);
	const integration = findIntegration(VAULT_INTEGRATION_ID);
	const collection = integration && findCollection(integration, ENTRIES);
	if (!vault || !collection || !human) {
		return <NotFound what="vault" />;
	}

	const made = !vault.builtIn;
	const owner = ownerOf(vault, human);

	const open = (next: Editing | null) => {
		setError(null);
		setEditing(next);
	};
	// Closes the dialog once the change is saved; a failure keeps it open, saying what went wrong.
	const close = () => setEditing(null);

	return (
		<AppShell
			title={<PageTitle detail={integration?.name}>{connectionTitle(vault)}</PageTitle>}
			actions={
				<AddButton label="Add entry" variant="outline" onClick={() => open({entry: null})} />
			}
		>
			{made && (
				<p className="text-sm text-muted-foreground">
					{owner === 'You' ? 'Yours' : `${owner}’s`}
					{' · '}
					{sharedWith(vault, human.org.name)}
					{' · '}
					<Link
						to={`/${org}/connections/${vault.id}`}
						className="text-foreground underline underline-offset-4"
					>
						Sharing and permissions
					</Link>
				</p>
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
										? updateRecord(org, vault.id, ENTRIES, entry.id, values)
										: createRecord(org, vault.id, ENTRIES, values),
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
												void apply(deleteRecord(org, vault.id, ENTRIES, entry.id), close);
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
