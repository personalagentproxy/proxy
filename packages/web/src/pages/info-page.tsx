import {PlusIcon} from 'lucide-react';
import {useState} from 'react';
import {AppShell, PageTitle} from '@/components/app-shell';
import {useStore} from '@/components/mock-store';
import {RecordForm} from '@/components/record-form';
import {EmptyRows, Row, RowList} from '@/components/row-list';
import {Section} from '@/components/section';
import {Button} from '@/components/ui/button';
import {Dialog, DialogContent, DialogHeader, DialogTitle} from '@/components/ui/dialog';
import {displayValue, recordsOf, recordTitle} from '@/lib/access';
import {findIntegration, INFO_INTEGRATION_ID} from '@/lib/integrations';
import {INFO_CONNECTION_ID} from '@/lib/mock-data';
import type {Collection, DataRecord} from '@/lib/types';

// Which record the dialog is open on: a new one in a collection, or one being edited.
type Editing = {collection: Collection; record: DataRecord | null};

// What you keep in Proxy for agents to use, grouped by collection; a row opens it for editing.
export function InfoPage() {
	const {state, saveRecord, deleteRecord} = useStore();
	const [editing, setEditing] = useState<Editing | null>(null);
	const collections = findIntegration(INFO_INTEGRATION_ID)?.collections ?? [];

	return (
		<AppShell title={<PageTitle>Information</PageTitle>}>
			<div className="flex flex-col gap-8">
				{collections.map((collection) => {
					const records = recordsOf(state, INFO_CONNECTION_ID, collection.id);
					const summary = collection.fields.find((field) => field.key === collection.summaryField);
					return (
						<Section
							key={collection.id}
							title={collection.name}
							action={
								<Button
									size="xs"
									variant="ghost"
									onClick={() => setEditing({collection, record: null})}
								>
									<PlusIcon data-icon="inline-start" />
									Add
								</Button>
							}
						>
							<RowList>
								{records.length === 0 && <EmptyRows>None yet.</EmptyRows>}
								{records.map((record) => (
									<Row
										key={record.id}
										onClick={() => setEditing({collection, record})}
										title={recordTitle(collection, record)}
										cells={
											summary && (
												<span className="shrink-0 text-muted-foreground tabular-nums">
													{displayValue(summary.type, record.values[summary.key])}
												</span>
											)
										}
									/>
								))}
							</RowList>
						</Section>
					);
				})}
			</div>
			<Dialog
				open={editing !== null}
				onOpenChange={(next) => {
					if (next) {
						return;
					}
					setEditing(null);
				}}
			>
				{editing && (
					<DialogContent>
						<DialogHeader>
							<DialogTitle>
								{editing.record
									? recordTitle(editing.collection, editing.record)
									: `New ${editing.collection.singular}`}
							</DialogTitle>
						</DialogHeader>
						<RecordForm
							fields={editing.collection.fields}
							initial={editing.record?.values}
							submitLabel="Save"
							onCancel={() => setEditing(null)}
							onSubmit={(values) => {
								saveRecord(INFO_CONNECTION_ID, editing.collection.id, values, editing.record?.id);
								setEditing(null);
							}}
							extra={
								editing.record && (
									<Button
										type="button"
										variant="destructive"
										onClick={() => {
											if (editing.record) {
												deleteRecord(editing.record.id);
											}
											setEditing(null);
										}}
									>
										Delete
									</Button>
								)
							}
						/>
					</DialogContent>
				)}
			</Dialog>
		</AppShell>
	);
}
