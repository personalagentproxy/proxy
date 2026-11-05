import type {DataRecord} from '@proxy/contracts/records';
import {useState} from 'react';
import {useLoaderData, useRevalidator} from 'react-router';
import {deleteRecord} from '@/client/records-client';
import {AppShell, PageTitle} from '@/components/app-shell';
import {Row, RowHeader, RowList} from '@/components/row-list';
import {SideEmpty, SideToggle} from '@/components/share-toggle';
import {Badge} from '@proxy/ui/components/badge';
import {Button} from '@proxy/ui/components/button';
import {Dialog, DialogContent, DialogHeader, DialogTitle} from '@proxy/ui/components/dialog';
import {useApply} from '@/hooks/use-apply';
import {useHuman} from '@/hooks/use-human';
import {useOrgSlug} from '@/hooks/use-org';
import {useSide} from '@/hooks/use-side';
import {formatAgo, formatDateTime} from '@/lib/format';
import type {sandboxesLoader} from '@/loaders';

const SANDBOXES = 'sandboxes';

const OWN_EMPTY = 'No sandboxes yet. Your agents make one when their work needs a computer.';

// The table's columns after the name.
const CELLS = {
	state: 'w-24 shrink-0',
	heldBy: 'hidden w-2/5 shrink-0 truncate text-muted-foreground md:block',
	lastUsed: 'w-28 shrink-0 text-right text-muted-foreground',
};

// A sandbox with the connection it is on, since the page lists two connections' sandboxes.
type Listed = {sandbox: DataRecord; connectionId: string; shared: boolean};

function StateBadge({state}: {state: string}) {
	return (
		<Badge variant={state === 'Running' ? 'default' : 'secondary'} className="font-normal">
			{state}
		</Badge>
	);
}

// The sandboxes agents made, the person's own and the organization's: each with whether it is
// running or asleep, the task using it, and when it was last used, opened for a closer look and
// deleted there once its work is done. With anyone else in the organization or invited, a toggle
// picks whose, as the vault's does.
export function SandboxesPage() {
	const org = useOrgSlug();
	const {own, shared} = useLoaderData<typeof sandboxesLoader>();
	const human = useHuman();
	const revalidator = useRevalidator();
	const [selected, setSelected] = useState<Listed | null>(null);
	const [error, setError] = useState<string | null>(null);
	const apply = useApply(setError);
	const list = (
		kept: {connectionId: string; sandboxes: DataRecord[]} | null,
		inShared: boolean,
	): Listed[] =>
		(kept?.sandboxes ?? []).map((sandbox) => ({
			sandbox,
			connectionId: kept?.connectionId ?? '',
			shared: inShared,
		}));
	const side = useSide([...list(own, false), ...list(shared, true)], {opensOnShared: false});
	if (!human) {
		return null;
	}
	const activeOrg = human.org;
	const open = (next: Listed | null) => {
		setError(null);
		setSelected(next);
	};
	const close = () => {
		setSelected(null);
		void revalidator.revalidate();
	};

	return (
		<AppShell title={<PageTitle>Sandboxes</PageTitle>}>
			<SideToggle side={side} orgName={activeOrg.name} />
			<RowList
				header={
					<RowHeader>
						<span className="min-w-0 flex-1">Name</span>
						<span className={CELLS.state}>State</span>
						<span className={CELLS.heldBy}>In use by</span>
						<span className={CELLS.lastUsed}>Last used</span>
					</RowHeader>
				}
			>
				{side.shown.length === 0 && (
					<SideEmpty
						side={side}
						alone={OWN_EMPTY}
						shared={`No sandboxes yet. ${activeOrg.name}'s shared agents make one when their work needs a computer.`}
						own={OWN_EMPTY}
					/>
				)}
				{side.shown.map((item) => (
					<Row
						key={item.sandbox.id}
						onClick={() => open(item)}
						title={item.sandbox.values.name ?? ''}
						cells={
							<>
								<span className={CELLS.state}>
									<StateBadge state={item.sandbox.values.state ?? ''} />
								</span>
								<span className={CELLS.heldBy}>{item.sandbox.values.heldBy || ''}</span>
								<span className={CELLS.lastUsed}>
									{item.sandbox.values.lastUsedAt ? formatAgo(item.sandbox.values.lastUsedAt) : ''}
								</span>
							</>
						}
					/>
				))}
			</RowList>
			<Dialog
				open={selected !== null}
				onOpenChange={(next) => {
					if (!next) {
						open(null);
					}
				}}
			>
				{selected && (
					<DialogContent>
						<DialogHeader>
							<DialogTitle>{selected.sandbox.values.name}</DialogTitle>
						</DialogHeader>
						<dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
							<dt className="text-muted-foreground">State</dt>
							<dd>
								<StateBadge state={selected.sandbox.values.state ?? ''} />
							</dd>
							<dt className="text-muted-foreground">In use by</dt>
							<dd>{selected.sandbox.values.heldBy || 'No task'}</dd>
							<dt className="text-muted-foreground">Last used</dt>
							<dd>
								{selected.sandbox.values.lastUsedAt
									? formatDateTime(selected.sandbox.values.lastUsedAt)
									: ''}
							</dd>
							<dt className="text-muted-foreground">Whose</dt>
							<dd>{selected.shared ? `Everyone in ${activeOrg.name}` : 'Just me'}</dd>
						</dl>
						<p className="text-sm text-muted-foreground">
							Deleting a sandbox deletes everything on it, for good.
						</p>
						<div className="flex justify-end gap-2">
							<Button type="button" variant="outline" onClick={() => open(null)}>
								Close
							</Button>
							<Button
								type="button"
								variant="destructive"
								onClick={() => {
									void apply(
										deleteRecord(org, selected.connectionId, SANDBOXES, selected.sandbox.id),
										close,
									);
								}}
							>
								Delete
							</Button>
						</div>
						{error && <p className="text-sm text-destructive">{error}</p>}
					</DialogContent>
				)}
			</Dialog>
		</AppShell>
	);
}
