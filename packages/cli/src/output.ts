import {findIntegration, INTEGRATIONS} from '@proxy/integrations';

import type {DataRecord, Me, ToolInfo, ToolResult} from './api';

/**
 * What a command prints for reading: one line per thing, its id first, so a line can be cut out
 * and handed to the next command. `--json` prints the server's own answer instead.
 */

// The fields records are titled by, from the catalog: a task's title, an email's subject.
const TITLE_KEYS = [
	...new Set(
		INTEGRATIONS.flatMap((integration) =>
			integration.collections.map((collection) => collection.titleField),
		),
	),
];

function actionLabels(integrationId: string, actions: string[]): string {
	const integration = findIntegration(integrationId);
	return actions
		.map((id) => integration?.actions.find((action) => action.id === id)?.label ?? id)
		.join(', ');
}

export function formatMe(me: Me): string {
	if (me.connections.length === 0) {
		return `Signed in as ${me.agent.name}, with no access yet: the person who made this login has to give it some.`;
	}
	const lines = me.connections.map((connection) => {
		const name = findIntegration(connection.integrationId)?.name ?? connection.integrationId;
		return `${connection.id}  ${name} (${connection.account})  ${actionLabels(connection.integrationId, connection.actions)}`;
	});
	return [`Signed in as ${me.agent.name}.`, ...lines].join('\n');
}

// "id*, title, priority": the params a tool takes, the required ones starred.
function paramList(tool: ToolInfo): string {
	const {properties, required} = tool.inputSchema;
	return Object.keys(properties)
		.map((key) => (required.includes(key) ? `${key}*` : key))
		.join(', ');
}

export function formatTools(tools: ToolInfo[]): string {
	if (tools.length === 0) {
		return 'No tools: this login may not do anything with this connection.';
	}
	return tools
		.map((tool) => {
			const params = paramList(tool);
			return `${tool.name}  ${tool.readOnly ? 'reads' : 'changes'}  ${tool.description}${params ? `\n    params: ${params}` : ''}`;
		})
		.join('\n');
}

function titleOf(record: DataRecord): string {
	const key = TITLE_KEYS.find((candidate) => record.values[candidate]?.trim());
	return key ? (record.values[key] ?? '').trim() : '(untitled)';
}

// Every field with something in it, a value over several lines indented under its name.
function recordText(record: DataRecord): string {
	const fields = Object.entries(record.values)
		.filter(([, value]) => value.trim() !== '')
		.map(([key, value]) =>
			value.includes('\n') ? `${key}:\n${value.replace(/^/gm, '    ')}` : `${key}: ${value}`,
		);
	return [`id: ${record.id}`, ...fields].join('\n');
}

export function formatToolResult(result: ToolResult): string {
	if ('record' in result) {
		return result.record ? recordText(result.record) : 'Done.';
	}
	const where =
		result.trail && result.trail.length > 0
			? [`In ${result.trail.map((crumb) => crumb.title).join(' / ')}`]
			: [];
	const lines = result.records.map(
		(record) =>
			`${record.id}  ${titleOf(record)}${record.hasChildren ? '  (holds more: list it as parent)' : ''}`,
	);
	const empty = result.records.length === 0 ? ['Nothing here.'] : [];
	const next = result.nextPage ? [`More: add "page": "${result.nextPage}" to the params`] : [];
	return [...where, ...lines, ...empty, ...next].join('\n');
}
