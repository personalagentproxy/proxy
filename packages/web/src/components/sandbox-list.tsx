import type {DataRecord} from '@proxy/contracts/records';
import {useState} from 'react';
import {deleteRecord} from '@/client/records-client';
import {EmptyRows, Row, RowHeader, RowList} from '@/components/row-list';
import {Badge} from '@proxy/ui/components/badge';
import {PillButton} from '@proxy/ui/components/pill-button';
import {Dialog, DialogContent, DialogHeader, DialogTitle} from '@proxy/ui/components/dialog';
import {useApply} from '@/hooks/use-apply';
import {useOrgSlug} from '@/hooks/use-org';
import {useReload} from '@/hooks/use-reload';
import {formatAgo, formatDateTime} from '@/lib/format';

const SANDBOXES = 'sandboxes';

const EMPTY = 'No sandboxes yet. Your agents make one when their work needs a computer.';

// The table's columns after the name.
const CELLS = {
	state: 'w-24 shrink-0',
	heldBy: 'hidden w-2/5 shrink-0 truncate text-muted-foreground md:block',
	lastUsed: 'w-28 shrink-0 text-right text-muted-foreground',
};

function StateBadge({state}: {state: string}) {
	return (
		<Badge variant={state === 'Running' ? 'default' : 'secondary'} className="font-normal">
			{state}
		</Badge>
	);
}

type Props = {
	// The person's Sandboxes connection.
	connectionId: string;
	sandboxes: DataRecord[];
};

// The Sandboxes part of the person's Sandboxes connection's page, the first of its tabs: the
// sandboxes their agents made, each with whether it is running or asleep, the task using it, and
// when it was last used, opened for a closer look and deleted there once its work is done.
export function SandboxList({connectionId, sandboxes}: Props) {
	const org = useOrgSlug();
	const reload = useReload();
	const [selected, setSelected] = useState<DataRecord | null>(null);
	const [error, setError] = useState<string | null>(null);
	const apply = useApply(setError);
	const open = (next: DataRecord | null) => {
		setError(null);
		setSelected(next);
	};
	const close = () => {
		setSelected(null);
		void reload();
	};

	return (
		<div className="flex flex-col gap-2">
			<p className="flex min-h-8 items-center text-sm text-muted-foreground">
				The computers your agents asked for, kept while they are away
			</p>
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
				{sandboxes.length === 0 && <EmptyRows>{EMPTY}</EmptyRows>}
				{sandboxes.map((sandbox) => (
					<Row
						key={sandbox.id}
						onClick={() => open(sandbox)}
						title={sandbox.values.name ?? ''}
						cells={
							<>
								<span className={CELLS.state}>
									<StateBadge state={sandbox.values.state ?? ''} />
								</span>
								<span className={CELLS.heldBy}>{sandbox.values.heldBy || ''}</span>
								<span className={CELLS.lastUsed}>
									{sandbox.values.lastUsedAt ? formatAgo(sandbox.values.lastUsedAt) : ''}
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
							<DialogTitle>{selected.values.name}</DialogTitle>
						</DialogHeader>
						<dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
							<dt className="text-muted-foreground">State</dt>
							<dd>
								<StateBadge state={selected.values.state ?? ''} />
							</dd>
							<dt className="text-muted-foreground">In use by</dt>
							<dd>{selected.values.heldBy || 'No task'}</dd>
							<dt className="text-muted-foreground">Last used</dt>
							<dd>
								{selected.values.lastUsedAt ? formatDateTime(selected.values.lastUsedAt) : ''}
							</dd>
						</dl>
						<p className="text-sm text-muted-foreground">
							Deleting a sandbox deletes everything on it, for good.
						</p>
						<div className="flex justify-end gap-2">
							<PillButton type="button" variant="ghost" onClick={() => open(null)}>
								Close
							</PillButton>
							<PillButton
								type="button"
								variant="destructive"
								onClick={() => {
									void apply(deleteRecord(org, connectionId, SANDBOXES, selected.id), close);
								}}
							>
								Delete
							</PillButton>
						</div>
						{error && <p className="text-sm text-destructive">{error}</p>}
					</DialogContent>
				)}
			</Dialog>
		</div>
	);
}
