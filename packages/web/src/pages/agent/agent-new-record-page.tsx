import {useState} from 'react';
import {useNavigate} from 'react-router';
import {createAgentRecord} from '@/client/agent-client';
import {AgentHeading, AgentShell, Crumbs} from '@/components/agent-shell';
import {RecordForm} from '@/components/record-form';
import {useAgentTarget} from '@/hooks/use-agent-target';
import {allows} from '@/lib/access';
import {agentErrorMessage} from '@/lib/agent-errors';
import {AgentDenied} from '@/pages/agent/agent-collection-page';

// A new record in a collection the agent may create records in. Without that access the form isn't
// offered; the api would refuse the create and log it as denied.
export function AgentNewRecordPage() {
	const navigate = useNavigate();
	const target = useAgentTarget();
	const [error, setError] = useState<string | null>(null);
	if (!target || !allows(target.collection, target.actions, 'create')) {
		return <AgentDenied>This login cannot create records here.</AgentDenied>;
	}

	const {connection, integration, collection} = target;
	const listPath = `/agent/${connection.id}/${collection.id}`;

	return (
		<AgentShell>
			<Crumbs
				items={[
					{label: 'Home', to: '/agent'},
					{label: integration.name},
					{label: collection.name, to: listPath},
					{label: 'New'},
				]}
			/>
			<div className="mb-6 md:px-3">
				<AgentHeading>New {collection.singular}</AgentHeading>
			</div>
			<div className="flex flex-col gap-3 md:px-3">
				{error && <p className="text-sm text-destructive">{error}</p>}
				<RecordForm
					fields={collection.fields}
					submitLabel={`Create ${collection.singular}`}
					onCancel={() => navigate(listPath)}
					onSubmit={async (values) => {
						const result = await createAgentRecord(connection.id, collection.id, values);
						if (result.isErr()) {
							setError(agentErrorMessage(result.error));
							return;
						}
						navigate(`${listPath}/${result.value.id}`, {replace: true});
					}}
				/>
			</div>
		</AgentShell>
	);
}
