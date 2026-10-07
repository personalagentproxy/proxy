import {toolName, type Command} from '@proxy/integrations';
import {useState} from 'react';
import {useNavigate} from 'react-router';
import {runAgentRecordTool} from '@/client/agent-client';
import {AgentHeading, AgentShell, Crumbs} from '@/components/agent-shell';
import {RecordForm} from '@/components/record-form';
import {useAgentTarget} from '@/hooks/use-agent-target';
import {allows, newCommands} from '@/lib/access';
import {agentErrorMessage} from '@/lib/agent-errors';
import {AgentDenied} from '@/pages/agent/agent-collection-page';

// A new record, saved or run through a command such as Send, whichever the agent may do: Send and
// Save as draft side by side when it may do both. Without either the form isn't offered; the api
// would refuse and log it as denied.
export function AgentNewRecordPage() {
	const navigate = useNavigate();
	const target = useAgentTarget();
	const [error, setError] = useState<string | null>(null);
	const canCreate = target !== null && allows(target.collection, target.actions, 'create');
	const [command] = target ? newCommands(target.collection, target.actions) : [];
	if (!target || (!canCreate && !command)) {
		return <AgentDenied>This login cannot add anything here.</AgentDenied>;
	}

	const {connection, collection, place} = target;
	const listPath = `/agent/${connection.id}/${collection.id}`;
	const createLabel = collection.createLabel ?? `Create ${collection.singular}`;
	const create = async (values: Record<string, string>) => {
		const result = await runAgentRecordTool(
			connection.id,
			toolName(collection.id, 'create'),
			values,
		);
		if (result.isErr()) {
			setError(agentErrorMessage(result.error));
			return;
		}
		navigate(result.value.record ? `${listPath}/${result.value.record.id}` : listPath, {
			replace: true,
		});
	};
	const run = async (chosen: Command, values: Record<string, string>) => {
		const result = await runAgentRecordTool(
			connection.id,
			toolName(collection.id, chosen.id),
			values,
		);
		if (result.isErr()) {
			setError(agentErrorMessage(result.error));
			return;
		}
		const title = values[collection.titleField]?.trim() || `untitled ${collection.singular}`;
		const notice = chosen.done.replace('{}', `${collection.singular} “${title}”`);
		navigate(allows(collection, target.actions, 'list') ? listPath : '/agent', {
			replace: true,
			state: {notice},
		});
	};

	return (
		<AgentShell>
			<Crumbs
				items={[
					{label: 'Home', to: '/agent'},
					{label: place},
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
					submitLabel={command ? command.label : createLabel}
					onCancel={() => navigate(command && !canCreate ? '/agent' : listPath)}
					onSubmit={(values) => void (command ? run(command, values) : create(values))}
					alternative={
						command && canCreate
							? {label: createLabel, onSubmit: (values) => void create(values)}
							: undefined
					}
				/>
			</div>
		</AgentShell>
	);
}
