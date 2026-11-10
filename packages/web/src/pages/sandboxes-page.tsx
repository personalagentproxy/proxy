import type {DataRecord} from '@proxy/contracts/records';
import {useState} from 'react';
import {useLoaderData, useRevalidator} from 'react-router';
import {deleteRecord} from '@/client/records-client';
import {AppShell, PageTitle} from '@/components/app-shell';
import {EmptyRows, Row, RowHeader, RowList} from '@/components/row-list';

import {Badge} from '@proxy/ui/components/badge';
import {Button} from '@proxy/ui/components/button';
import {Dialog, DialogContent, DialogHeader, DialogTitle} from '@proxy/ui/components/dialog';
import {useApply} from '@/hooks/use-apply';
import {useOrgSlug} from '@/hooks/use-org';
import {formatAgo, formatDateTime} from '@/lib/format';
import type {sandboxesLoader} from '@/loaders';

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

// The sandboxes the person's agents made, on their own Sandboxes connection: each with whether it
// is running or asleep, the task using it, and when it was last used, opened for a closer look and
// deleted there once its work is done.
export function SandboxesPage() {
	const org = useOrgSlug();
	const {connectionId, sandboxes} = useLoaderData<typeof sandboxesLoader>();
	const revalidator = useRevalidator();
	const [selected, setSelected] = useState<DataRecord | null>(null);
	const [error, setError] = useState<string | null>(null);
	const apply = useApply(setError);
	const open = (next: DataRecord | null) => {
		setError(null);
		setSelected(next);
	};
	const close = () => {
		setSelected(null);
		void revalidator.revalidate();
	};

	return (
		<AppShell title={<PageTitle>Sandboxes</PageTitle>}>
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
							<Button type="button" variant="outline" onClick={() => open(null)}>
								Close
							</Button>
							<Button
								type="button"
								variant="destructive"
								onClick={() => {
									if (connectionId !== null) {
										void apply(deleteRecord(org, connectionId, SANDBOXES, selected.id), close);
									}
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
