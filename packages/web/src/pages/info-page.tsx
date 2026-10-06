import {INFO_INTEGRATION_ID, type Collection} from '@proxy/integrations';
import type {FetchError} from '@proxy/utils';
import {PlusIcon} from 'lucide-react';
import {useState} from 'react';
import {useLoaderData, useRevalidator} from 'react-router';
import type {Result} from 'ts-results-es';
import {createRecord, deleteRecord, updateRecord} from '@/client/records-client';
import {AppShell, PageTitle} from '@/components/app-shell';
import {RecordForm} from '@/components/record-form';
import {EmptyRows, Row, RowList} from '@/components/row-list';
import {Section} from '@/components/section';
import {Button} from '@/components/ui/button';
import {Dialog, DialogContent, DialogHeader, DialogTitle} from '@/components/ui/dialog';
import {displayValue, recordTitle} from '@/lib/access';
import {findIntegration} from '@/lib/integrations';
import {describeFetchError} from '@/lib/loader-utils';
import type {DataRecord} from '@/lib/types';
import type {infoLoader} from '@/loaders';

// Which record the dialog is open on: a new one in a collection, or one being edited.
type Editing = {collection: Collection; record: DataRecord | null};

// What you keep in Proxy for agents to use, grouped by collection; a row opens it for editing.
export function InfoPage() {
	const {connectionId, records} = useLoaderData<typeof infoLoader>();
	const revalidator = useRevalidator();
	const [editing, setEditing] = useState<Editing | null>(null);
	const [error, setError] = useState<string | null>(null);
	const collections = findIntegration(INFO_INTEGRATION_ID)?.collections ?? [];
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
		<AppShell title={<PageTitle>Information</PageTitle>}>
			<div className="flex flex-col gap-8">
				{collections.map((collection) => {
					const rows = records[collection.id] ?? [];
					const summary = collection.fields.find((field) => field.key === collection.summaryField);
					return (
						<Section
							key={collection.id}
							title={collection.name}
							action={
								<Button size="xs" variant="ghost" onClick={() => open({collection, record: null})}>
									<PlusIcon data-icon="inline-start" />
									Add
								</Button>
							}
						>
							<RowList>
								{rows.length === 0 && <EmptyRows>None yet.</EmptyRows>}
								{rows.map((record) => (
									<Row
										key={record.id}
										onClick={() => open({collection, record})}
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
					open(null);
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
							onCancel={() => open(null)}
							onSubmit={(values) => {
								const {collection, record} = editing;
								void apply(
									record
										? updateRecord(connectionId, collection.id, record.id, values)
										: createRecord(connectionId, collection.id, values),
								);
							}}
							extra={
								editing.record && (
									<Button
										type="button"
										variant="destructive"
										onClick={() => {
											const {collection, record} = editing;
											if (record) {
												void apply(deleteRecord(connectionId, collection.id, record.id));
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
