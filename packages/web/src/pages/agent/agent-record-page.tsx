import {applies, type Command} from '@proxy/integrations';
import {useState} from 'react';
import {useLoaderData, useNavigate, useRevalidator} from 'react-router';
import {deleteAgentRecord, runAgentCommand, updateAgentRecord} from '@/client/agent-client';
import {AgentHeading, AgentShell, Crumbs} from '@/components/agent-shell';
import {RecordFields, RecordForm} from '@/components/record-form';
import {Button} from '@proxy/ui/components/button';
import {useAgentTarget} from '@/hooks/use-agent-target';
import {allows, recordTitle} from '@/lib/access';
import {agentErrorMessage} from '@/lib/agent-errors';
import type {agentRecordLoader} from '@/agent-loaders';
import {AgentDenied, AgentMissing} from '@/pages/agent/agent-collection-page';

// One record, with a button for everything the agent may do to it: the collection's commands, such
// as Archive or Send, then Edit and Delete. Editing happens in place; a saved record can come back
// under a new address, as an email draft does. A record that leaves the collection, as a sent draft
// does, returns to the list, which says what happened.
export function AgentRecordPage() {
	const outcome = useLoaderData<typeof agentRecordLoader>();
	const navigate = useNavigate();
	const revalidator = useRevalidator();
	const target = useAgentTarget();
	const [editing, setEditing] = useState(false);
	const [running, setRunning] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	if (outcome.kind === 'denied') {
		return <AgentDenied>This login has no access to this collection.</AgentDenied>;
	}

	if (outcome.kind === 'missing' || !target) {
		return <AgentMissing />;
	}

	const {connection, collection, place} = target;
	const {actions, record} = outcome.value;
	// What the agent may do, and what applies to this record: only a draft is sent or edited.
	const editable = applies(collection.editable, record.values);
	const canEdit = editable && allows(collection, actions, 'update');
	const canDelete = editable && allows(collection, actions, 'delete');
	const commands = (collection.commands ?? []).filter(
		(command) =>
			command.on === 'record' &&
			applies(command.where, record.values) &&
			allows(collection, actions, command.id),
	);
	const title = recordTitle(collection, record);
	const listPath = `/agent/${connection.id}/${collection.id}`;
	const run = async (command: Command) => {
		setRunning(command.id);
		const result = await runAgentCommand(connection.id, collection.id, record.id, command.id);
		setRunning(null);
		if (result.isErr()) {
			setError(agentErrorMessage(result.error));
			return;
		}
		setError(null);
		if (result.value.record === null) {
			const notice = command.done.replace('{}', `${collection.singular} “${title}”`);
			navigate(listPath, {replace: true, state: {notice}});
			return;
		}
		await revalidator.revalidate();
	};

	return (
		<AgentShell>
			<Crumbs
				items={[
					{label: 'Home', to: '/agent'},
					{label: place},
					{label: collection.name, to: listPath},
					{label: title},
				]}
			/>
			<div className="mb-4 md:px-3">
				<AgentHeading>{editing ? `Edit ${collection.singular}` : title}</AgentHeading>
			</div>
			{(commands.length > 0 || canEdit || canDelete) && !editing && (
				<div className="mb-6 flex flex-wrap gap-2 md:px-3">
					{commands.map((command) => (
						<Button
							key={command.id}
							size="sm"
							variant="outline"
							disabled={running !== null}
							onClick={() => void run(command)}
						>
							{running === command.id ? `${command.label}…` : command.label}
						</Button>
					))}
					{canEdit && (
						<Button size="sm" variant="outline" onClick={() => setEditing(true)}>
							Edit
						</Button>
					)}
					{canDelete && (
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
