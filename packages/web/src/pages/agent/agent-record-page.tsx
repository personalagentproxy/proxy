import {allowsWrite} from '@proxy/integrations';
import {useState} from 'react';
import {useLoaderData, useNavigate} from 'react-router';
import {deleteAgentRecord, updateAgentRecord} from '@/client/agent-client';
import {AgentHeading, AgentShell, Crumbs} from '@/components/agent-shell';
import {RecordFields, RecordForm} from '@/components/record-form';
import {Button} from '@proxy/ui/components/button';
import {useAgentTarget} from '@/hooks/use-agent-target';
import {recordTitle} from '@/lib/access';
import {agentErrorMessage} from '@/lib/agent-errors';
import type {agentRecordLoader} from '@/agent-loaders';
import {AgentDenied, AgentMissing} from '@/pages/agent/agent-collection-page';

// One record, with Edit and Delete when the agent may write. Editing happens in place; a saved
// record can come back under a new address, as an email draft does.
export function AgentRecordPage() {
	const outcome = useLoaderData<typeof agentRecordLoader>();
	const navigate = useNavigate();
	const target = useAgentTarget();
	const [editing, setEditing] = useState(false);
	const [error, setError] = useState<string | null>(null);
	if (outcome.kind === 'denied') {
		return <AgentDenied>This login has no access to this collection.</AgentDenied>;
	}

	if (outcome.kind === 'missing' || !target) {
		return <AgentMissing />;
	}

	const {connection, integration, collection} = target;
	const {access, record} = outcome.value;
	const title = recordTitle(collection, record);
	const listPath = `/agent/${connection.id}/${collection.id}`;

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
						{allowsWrite(collection, 'update') && (
							<Button size="sm" variant="outline" onClick={() => setEditing(true)}>
								Edit
							</Button>
						)}
						{allowsWrite(collection, 'delete') && (
							<Button
								size="sm"
								variant="destructive"
								onClick={async () => {
									const result = await deleteAgentRecord(connection.id, collection.id, record.id);
									if (result.isErr()) {
										setError(agentErrorMessage(result.error));
										return;
									}
									navigate(listPath);
								}}
							>
								Delete
							</Button>
						)}
					</div>
				)}
			</div>
			<div className="flex flex-col gap-3 md:px-3">
				{error && <p className="text-sm text-destructive">{error}</p>}
				{editing ? (
					<RecordForm
						fields={collection.fields}
						initial={record.values}
						submitLabel="Save"
						onCancel={() => setEditing(false)}
						onSubmit={async (values) => {
							const result = await updateAgentRecord(
								connection.id,
								collection.id,
								record.id,
								values,
							);
							if (result.isErr()) {
								setError(agentErrorMessage(result.error));
								return;
							}
							setError(null);
							setEditing(false);
							navigate(`${listPath}/${result.value.id}`, {replace: true});
						}}
					/>
				) : (
					<RecordFields fields={collection.fields} values={record.values} />
				)}
			</div>
		</AgentShell>
	);
}
