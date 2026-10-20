import {toolName, type Command} from '@proxy/integrations';
import {useState} from 'react';
import {useLocation, useNavigate, useSearchParams} from 'react-router';
import {runAgentRecordTool} from '@/client/agent-client';
import {AgentHeading, AgentShell, Crumbs} from '@/components/agent-shell';
import {RecordFields, RecordForm} from '@/components/record-form';
import {useAgentTarget} from '@/hooks/use-agent-target';
import {allows, newCommands} from '@/lib/access';
import {agentErrorMessage} from '@/lib/agent-errors';
import {inside, recordPath} from '@/lib/agent-paths';
import type {DataRecord} from '@/lib/types';
import {AgentDenied} from '@/pages/agent/agent-collection-page';

// The title of the record a new one goes inside, as the list it was started from hands it over.
function parentTitleFromState(state: unknown): string | null {
	if (typeof state !== 'object' || state === null || !('parentTitle' in state)) {
		return null;
	}
	return typeof state.parentTitle === 'string' ? state.parentTitle : null;
}

// A new record, saved or run through a command such as Send, whichever the agent may do: Send and
// Save as draft side by side when it may do both, or two commands side by side, as Read and Write
// on a range. Without either the form isn't offered; the api would refuse and log it as denied. In
// a nested collection it goes inside `?parent=` when given, such as a page inside the one the agent
// was looking at. A command that answers something, as running a query answers its rows, shows it
// under the form, where the next one can be written.
export function AgentNewRecordPage() {
	const navigate = useNavigate();
	const [params] = useSearchParams();
	const parentTitle = parentTitleFromState(useLocation().state);
	const target = useAgentTarget();
	const [error, setError] = useState<string | null>(null);
	const [answer, setAnswer] = useState<DataRecord | null>(null);
	const canCreate = target !== null && allows(target.collection, target.actions, 'create');
	const [command, second] = target ? newCommands(target.collection, target.actions) : [];
	if (!target || (!canCreate && !command)) {
		return <AgentDenied>This login cannot add anything here.</AgentDenied>;
	}

	const {connection, collection, place} = target;
	const parent = params.get('parent');
	const recordsPath = `/agent/${connection.id}/${collection.id}`;
	const listPath = `${recordsPath}${inside(parent)}`;
	const createLabel = collection.createLabel ?? `Create ${collection.singular}`;
	const create = async (values: Record<string, string>) => {
		const result = await runAgentRecordTool(
			connection.id,
			toolName(collection.id, 'create'),
			parent ? {...values, parent} : values,
		);
		if (result.isErr()) {
			setError(agentErrorMessage(result.error));
			return;
		}
		navigate(result.value.record ? recordPath(recordsPath, result.value.record.id) : listPath, {
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
		if (result.value.record) {
			setError(null);
			setAnswer(result.value.record);
			return;
		}
		const title = values[collection.titleField]?.trim() || `untitled ${collection.singular}`;
		const notice = chosen.done.replace('{}', `${collection.singular} “${title}”`);
		navigate(allows(collection, target.actions, 'list') ? listPath : '/agent', {
			replace: true,
			state: {notice},
		});
	};

	// Beside a command, saving the record where the agent may, else the next command, as Write
	// beside Read on a range.
	const alternative = () => {
		if (command && canCreate) {
			return {
				label: createLabel,
				onSubmit: (values: Record<string, string>) => void create(values),
			};
		}
		if (command && second) {
			return {
				label: second.label,
				onSubmit: (values: Record<string, string>) => void run(second, values),
			};
		}
		return undefined;
	};

	return (
		<AgentShell>
			<Crumbs
				items={[
					{label: 'Home', to: '/agent'},
					{label: place},
					{label: collection.name, to: recordsPath},
					...(parent ? [{label: parentTitle ?? 'Where it goes', to: listPath}] : []),
					{label: 'New'},
				]}
			/>
			<AgentHeading>
				New {collection.singular}
				{parentTitle ? ` in “${parentTitle}”` : ''}
			</AgentHeading>
			<div className="flex flex-col gap-3">
				{error && <p className="text-sm text-destructive">{error}</p>}
				<RecordForm
					fields={collection.fields}
					submitLabel={command ? command.label : createLabel}
					onCancel={() => navigate(command && !canCreate ? '/agent' : listPath)}
					onSubmit={(values) => void (command ? run(command, values) : create(values))}
					alternative={alternative()}
				/>
				{answer && (
					<RecordFields
						fields={collection.fields.filter((field) => field.system)}
						values={answer.values}
					/>
				)}
			</div>
		</AgentShell>
	);
}
