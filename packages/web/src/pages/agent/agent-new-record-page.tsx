import {useNavigate} from 'react-router';
import {AgentHeading, AgentShell, Crumbs} from '@/components/agent-shell';
import {useStore} from '@/components/mock-store';
import {RecordForm} from '@/components/record-form';
import {useAgentTarget} from '@/hooks/use-agent-target';
import {useAuditOnce} from '@/hooks/use-audit';
import {withSystemValues} from '@/lib/access';
import {AgentDenied, AgentMissing} from '@/pages/agent/agent-collection-page';

// A new record in a collection the agent may write to. Reaching the form without that access is
// logged as a denied create.
export function AgentNewRecordPage() {
	const navigate = useNavigate();
	const {saveRecord, log} = useStore();
	const target = useAgentTarget();
	useAuditOnce(
		target && target.access !== 'write'
			? {
					connectionId: target.connection.id,
					collectionId: target.collection.id,
					action: 'create',
					recordTitle: null,
					outcome: 'denied',
				}
			: null,
	);

	if (!target) {
		return <AgentMissing />;
	}

	const {connection, integration, collection, access} = target;
	if (access !== 'write') {
		return <AgentDenied>This login cannot create {collection.name.toLowerCase()}.</AgentDenied>;
	}

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
			<div className="md:px-3">
				<RecordForm
					fields={collection.fields}
					submitLabel={`Create ${collection.singular}`}
					onCancel={() => navigate(listPath)}
					onSubmit={(values) => {
						const id = saveRecord(
							connection.id,
							collection.id,
							withSystemValues(collection, connection, values),
						);
						log({
							connectionId: connection.id,
							collectionId: collection.id,
							action: 'create',
							recordTitle: values[collection.titleField] ?? null,
							outcome: 'allowed',
						});
						navigate(`${listPath}/${id}`, {replace: true});
					}}
				/>
			</div>
		</AgentShell>
	);
}
