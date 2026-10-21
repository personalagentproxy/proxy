import {mcpToolReadsOnly, mcpToolTitle, type McpSchemaProperty} from '@proxy/integrations';
import {useId, useState} from 'react';
import {useParams} from 'react-router';
import {runAgentServerTool} from '@/client/agent-client';
import {AgentHeading, AgentShell, Crumbs} from '@/components/agent-shell';
import {Button} from '@proxy/ui/components/button';
import {Input} from '@proxy/ui/components/input';
import {Label} from '@proxy/ui/components/label';
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@proxy/ui/components/select';
import {Textarea} from '@proxy/ui/components/textarea';
import {useAgentMe} from '@/hooks/use-agent-target';
import {agentErrorMessage} from '@/lib/agent-errors';
import {taskHome, useTaskId} from '@/lib/agent-task';
import {AgentMissing} from '@/pages/agent/agent-collection-page';

// What a property's input is, from its JSON Schema: a choice, a number, yes or no, text, or JSON
// for anything else.
type InputKind = 'enum' | 'number' | 'boolean' | 'text' | 'json';

function kindOf(property: McpSchemaProperty): InputKind {
	if (property.enum && property.enum.length > 0) {
		return 'enum';
	}
	const types = Array.isArray(property.type) ? property.type : [property.type];
	const type = types.find((candidate) => candidate !== undefined && candidate !== 'null');
	if (type === 'number' || type === 'integer') {
		return 'number';
	}
	if (type === 'boolean') {
		return 'boolean';
	}
	if (type === 'string' || type === undefined) {
		return 'text';
	}
	return 'json';
}

// A typed-in value as the tool takes it; a blank is left out. JSON that doesn't read is an error
// the agent can act on.
function valueOf(
	property: McpSchemaProperty,
	kind: InputKind,
	typed: string,
): {ok: true; value: unknown} | {ok: false; message: string} {
	if (kind === 'enum') {
		const chosen = (property.enum ?? []).find((option) => String(option) === typed);
		return {ok: true, value: chosen};
	}
	if (kind === 'number') {
		const number = Number(typed);
		return Number.isFinite(number)
			? {ok: true, value: number}
			: {ok: false, message: 'has to be a number'};
	}
	if (kind === 'boolean') {
		return {ok: true, value: typed === 'true'};
	}
	if (kind === 'text') {
		return {ok: true, value: typed};
	}
	try {
		return {ok: true, value: JSON.parse(typed)};
	} catch {
		return {ok: false, message: 'has to be JSON'};
	}
}

// One of a custom MCP server's tools, run from a form of its params: one input per property, as
// the tool's schema describes them, and what the tool answered below, as the server wrote it. Built
// for a model driving a browser, so every param is labeled with its name and what the server says
// about it. Keyed by the tool, so the params and the answer start over for each.
export function AgentToolPage() {
	const {connectionId = '', toolName = ''} = useParams();
	return (
		<AgentTool
			key={`${connectionId}/${toolName}`}
			connectionId={connectionId}
			toolName={toolName}
		/>
	);
}

function AgentTool({connectionId, toolName}: {connectionId: string; toolName: string}) {
	const id = useId();
	const me = useAgentMe();
	const taskId = useTaskId();
	const home = taskHome(taskId);
	const [values, setValues] = useState<Record<string, string>>({});
	const [output, setOutput] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [running, setRunning] = useState(false);
	const connection = me?.connections.find((candidate) => candidate.id === connectionId);
	const tool = connection?.tools?.find((candidate) => candidate.name === toolName);
	// The api lists only the tools the agent may run, so any other is simply not here.
	if (!connection || !tool) {
		return <AgentMissing />;
	}

	const title = mcpToolTitle(tool);
	const properties = Object.entries(tool.inputSchema.properties ?? {});
	const required = new Set(tool.inputSchema.required ?? []);
	const set = (key: string, value: string) => setValues((current) => ({...current, [key]: value}));

	const run = async () => {
		const params: Record<string, unknown> = {};
		for (const [key, property] of properties) {
			const typed = values[key] ?? '';
			if (typed.trim() === '') {
				continue;
			}
			const parsed = valueOf(property, kindOf(property), typed);
			if (!parsed.ok) {
				setError(`${key} ${parsed.message}.`);
				return;
			}
			params[key] = parsed.value;
		}
		setRunning(true);
		setError(null);
		const result = await runAgentServerTool(taskId, connection.id, tool.name, params);
		setRunning(false);
		if (result.isErr()) {
			setError(agentErrorMessage(result.error));
			return;
		}
		setOutput(result.value.text);
	};

	return (
		<AgentShell>
			<Crumbs items={[{label: 'Home', to: home}, {label: connection.account}, {label: title}]} />
			<AgentHeading detail={mcpToolReadsOnly(tool) ? 'Only reads' : 'Changes something'}>
				{title}
			</AgentHeading>
			<div className="flex flex-col gap-4">
				{tool.description && (
					<p className="text-sm whitespace-pre-wrap text-muted-foreground">{tool.description}</p>
				)}
				<form
					className="grid gap-4"
					onSubmit={(event) => {
						event.preventDefault();
						void run();
					}}
				>
					{properties.length === 0 && (
						<p className="text-sm text-muted-foreground">This tool takes no params.</p>
					)}
					{properties.map(([key, property]) => {
						const kind = kindOf(property);
						const inputId = `${id}-${key}`;
						return (
							<div key={key} className="grid gap-2">
								<Label htmlFor={inputId}>
									{key}
									{required.has(key) && (
										<span className="font-normal text-muted-foreground"> (required)</span>
									)}
								</Label>
								<ParamInput
									id={inputId}
									property={property}
									kind={kind}
									value={values[key] ?? ''}
									onChange={(value) => set(key, value)}
								/>
								{property.description && (
									<p className="text-sm text-muted-foreground">{property.description}</p>
								)}
							</div>
						);
					})}
					{error && <p className="text-sm text-destructive">{error}</p>}
					<div className="flex justify-end">
						<Button type="submit" disabled={running}>
							{running ? 'Running…' : `Run ${title}`}
						</Button>
					</div>
				</form>
				{output !== null && (
					<section className="grid gap-2">
						<h2 className="text-sm font-medium">Result</h2>
						<pre className="rounded-lg border bg-muted/50 p-3 text-sm whitespace-pre-wrap">
							{output || 'The tool answered with nothing.'}
						</pre>
					</section>
				)}
			</div>
		</AgentShell>
	);
}

type ParamProps = {
	id: string;
	property: McpSchemaProperty;
	kind: InputKind;
	value: string;
	onChange: (value: string) => void;
};

function ParamInput({id, property, kind, value, onChange}: ParamProps) {
	if (kind === 'enum' || kind === 'boolean') {
		const options = kind === 'boolean' ? ['true', 'false'] : (property.enum ?? []).map(String);
		return (
			<Select value={value || null} onValueChange={(next) => onChange(next ?? '')}>
				<SelectTrigger id={id} className="w-full">
					<SelectValue placeholder="Choose…" />
				</SelectTrigger>
				<SelectContent>
					{options.map((option) => (
						<SelectItem key={option} value={option}>
							{option}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
		);
	}

	if (kind === 'json') {
		return (
			<Textarea
				id={id}
				rows={4}
				placeholder="JSON"
				value={value}
				onChange={(event) => onChange(event.target.value)}
			/>
		);
	}

	return (
		<Input
			id={id}
			type={kind === 'number' ? 'number' : 'text'}
			autoComplete="off"
			value={value}
			onChange={(event) => onChange(event.target.value)}
		/>
	);
}
