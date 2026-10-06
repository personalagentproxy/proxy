import {useState} from 'react';
import {useNavigate, useParams} from 'react-router';
import {AgentHeading, AgentShell, Crumbs} from '@/components/agent-shell';
import {useStore} from '@/components/mock-store';
import {RecordFields, RecordForm} from '@/components/record-form';
import {Button} from '@/components/ui/button';
import {useAgentTarget} from '@/hooks/use-agent-target';
import {useAuditOnce} from '@/hooks/use-audit';
import {recordTitle} from '@/lib/access';
import {AgentDenied, AgentMissing} from '@/pages/agent/agent-collection-page';

// One record, with Edit and Delete when the agent may write. Editing happens in place.
export function AgentRecordPage() {
	const {recordId = ''} = useParams();
	const navigate = useNavigate();
	const {state, saveRecord, deleteRecord, log} = useStore();
	const target = useAgentTarget();
	const [editing, setEditing] = useState(false);
	const record = state.records.find((candidate) => candidate.id === recordId);
	const found =
		target !== null && record !== undefined && record.collectionId === target.collection.id;
	useAuditOnce(
		found
			? {
					connectionId: target.connection.id,
					collectionId: target.collection.id,
					action: 'view',
					recordTitle: target.access === 'none' ? null : recordTitle(target.collection, record),
					outcome: target.access === 'none' ? 'denied' : 'allowed',
				}
			: null,
	);

	if (!target || !record || !found) {
		return <AgentMissing />;
	}

	const {connection, integration, collection, access} = target;
	if (access === 'none') {
		return <AgentDenied>This login has no access to {collection.name}.</AgentDenied>;
	}

	const title = recordTitle(collection, record);
	const listPath = `/agent/${connection.id}/${collection.id}`;
	const request = {
		connectionId: connection.id,
		collectionId: collection.id,
		outcome: 'allowed' as const,
	};

	return (
		<AgentShell>
			<Crumbs
				items={[
					{label: 'Home', to: '/agent'},
					{label: integration.name},
					{label: collection.name, to: listPath},
					{label: title},
				]}
			/>
			<div className="mb-6 flex items-center justify-between gap-4 md:px-3">
				<AgentHeading>{editing ? `Edit ${collection.singular}` : title}</AgentHeading>
				{access === 'write' && !editing && (
					<div className="flex shrink-0 gap-2">
						<Button size="sm" variant="outline" onClick={() => setEditing(true)}>
							Edit
						</Button>
						<Button
							size="sm"
							variant="destructive"
							onClick={() => {
								deleteRecord(record.id);
								log({...request, action: 'delete', recordTitle: title});
								navigate(listPath);
							}}
						>
							Delete
						</Button>
					</div>
				)}
			</div>
			<div className="md:px-3">
				{editing ? (
					<RecordForm
						fields={collection.fields}
						initial={record.values}
						submitLabel="Save"
						onCancel={() => setEditing(false)}
						onSubmit={(values) => {
							saveRecord(connection.id, collection.id, values, record.id);
							log({
								...request,
								action: 'update',
								recordTitle: values[collection.titleField] ?? title,
							});
							setEditing(false);
						}}
					/>
				) : (
					<RecordFields fields={collection.fields} values={record.values} />
				)}
			</div>
		</AgentShell>
	);
}
