import type {DataRecord} from '@proxy/contracts/records';
import {VAULT_SECRETS_COLLECTION_ID} from '@proxy/integrations';
import {EyeIcon, EyeOffIcon, KeyRoundIcon} from 'lucide-react';
import {useState} from 'react';
import {createRecord, deleteRecord, updateRecord} from '@/client/records-client';
import {AddButton} from '@/components/add-button';
import {CopyButton} from '@/components/copy-button';
import {IconButton} from '@/components/icon-button';
import {EmptyRows, Row, RowHeader, RowList} from '@/components/row-list';
import {useApply} from '@/hooks/use-apply';
import {useOrgSlug} from '@/hooks/use-org';
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@proxy/ui/components/dialog';
import {Input} from '@proxy/ui/components/input';
import {Label} from '@proxy/ui/components/label';
import {PillButton} from '@proxy/ui/components/pill-button';
import {Textarea} from '@proxy/ui/components/textarea';

const EMPTY = 'No secrets yet.';

const HIDDEN = '••••••••••••';

const CELLS = {
	note: 'hidden w-2/5 shrink-0 truncate text-muted-foreground md:block',
	value:
		'flex w-56 shrink-0 items-center justify-end gap-1 font-mono text-xs text-muted-foreground',
};

// One secret's value, hidden until the person shows it, and copied either way.
function SecretValue({value}: {value: string}) {
	const [shown, setShown] = useState(false);
	return (
		<>
			<span className="min-w-0 truncate">{shown ? value : HIDDEN}</span>
			<IconButton label={shown ? 'Hide' : 'Show'} onClick={() => setShown(!shown)}>
				{shown ? <EyeOffIcon /> : <EyeIcon />}
			</IconButton>
			<CopyButton value={value} label="Copy" />
		</>
	);
}

// A secret written by the person: its name, its value and what it is for.
function SecretDialog({
	connectionId,
	secret,
	onClose,
}: {
	connectionId: string;
	secret: DataRecord | null;
	onClose: () => void;
}) {
	const org = useOrgSlug();
	const [name, setName] = useState(secret?.values.name ?? '');
	const [value, setValue] = useState(secret?.values.value ?? '');
	const [note, setNote] = useState(secret?.values.note ?? '');
	const [error, setError] = useState<string | null>(null);
	const apply = useApply(setError);
	const values = {name: name.trim(), value, note};
	return (
		<DialogContent>
			<DialogHeader>
				<DialogTitle>{secret ? secret.values.name : 'New secret'}</DialogTitle>
				<DialogDescription>
					Agents see its name and note, never its value. Those with Use secrets have it given to
					their sandbox commands as an environment variable.
				</DialogDescription>
			</DialogHeader>
			<div className="flex flex-col gap-2">
				<Label htmlFor="secret-name">Name</Label>
				<Input
					id="secret-name"
					placeholder="OPENAI_API_KEY"
					className="font-mono"
					value={name}
					onChange={(event) => setName(event.target.value)}
				/>
			</div>
			<div className="flex flex-col gap-2">
				<Label htmlFor="secret-value">Value</Label>
				<Input
					id="secret-value"
					type="password"
					autoComplete="off"
					className="font-mono"
					value={value}
					onChange={(event) => setValue(event.target.value)}
				/>
			</div>
			<div className="flex flex-col gap-2">
				<Label htmlFor="secret-note">Note</Label>
				<Textarea
					id="secret-note"
					placeholder="What it is for"
					value={note}
					onChange={(event) => setNote(event.target.value)}
				/>
			</div>
			{error && <p className="text-sm text-destructive">{error}</p>}
			<DialogFooter>
				{secret && (
					<PillButton
						variant="destructive"
						className="mr-auto"
						onClick={() =>
							void apply(
								deleteRecord(org, connectionId, VAULT_SECRETS_COLLECTION_ID, secret.id),
								onClose,
							)
						}
					>
						Delete
					</PillButton>
				)}
				<PillButton variant="ghost" onClick={onClose}>
					Cancel
				</PillButton>
				<PillButton
					disabled={values.name === '' || value === ''}
					onClick={() =>
						void apply(
							secret
								? updateRecord(org, connectionId, VAULT_SECRETS_COLLECTION_ID, secret.id, values)
								: createRecord(org, connectionId, VAULT_SECRETS_COLLECTION_ID, values),
							onClose,
						)
					}
				>
					Save
				</PillButton>
			</DialogFooter>
		</DialogContent>
	);
}

type Props = {connectionId: string; secrets: DataRecord[]};

/**
 * The Secrets part of a vault's page: API keys and tokens, each by the environment variable a
 * sandbox command is given it as. The person sees, copies and changes the values; agents see the
 * names and notes, and those with Use secrets have them given to their commands.
 */
export function VaultSecrets({connectionId, secrets}: Props) {
	const [open, setOpen] = useState<{secret: DataRecord | null} | null>(null);
	const close = () => setOpen(null);
	return (
		<div className="flex flex-col gap-2">
			<div className="flex min-h-8 items-center justify-between gap-4 text-sm text-muted-foreground">
				<span>Keys and tokens your agents’ sandbox commands can use, never see</span>
				<AddButton label="Add secret" variant="ghost" onClick={() => setOpen({secret: null})} />
			</div>
			<RowList
				header={
					<RowHeader>
						<span className="min-w-0 flex-1">Name</span>
						<span className={CELLS.note}>Note</span>
						<span className={CELLS.value}>Value</span>
					</RowHeader>
				}
			>
				{secrets.length === 0 && <EmptyRows>{EMPTY}</EmptyRows>}
				{secrets.map((secret) => (
					<Row
						key={secret.id}
						icon={<KeyRoundIcon className="size-4 shrink-0 text-muted-foreground" />}
						onClick={() => setOpen({secret})}
						title={<span className="font-mono">{secret.values.name}</span>}
						cells={<span className={CELLS.note}>{secret.values.note}</span>}
						after={
							<span className={CELLS.value}>
								<SecretValue value={secret.values.value ?? ''} />
							</span>
						}
					/>
				))}
			</RowList>
			<Dialog
				open={open !== null}
				onOpenChange={(next) => {
					if (!next) {
						close();
					}
				}}
			>
				{open && <SecretDialog connectionId={connectionId} secret={open.secret} onClose={close} />}
			</Dialog>
		</div>
	);
}
