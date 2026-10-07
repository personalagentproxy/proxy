import {requiredAction} from './access';
import type {Action, Collection, Condition, Field, Integration} from './types';

// What an agent can do with a connection, as tools: listing and opening each collection's
// records, writing them, and each command, generated from the catalog. The agent side's pages and
// the MCP server both run them, so the catalog is all an integration needs to describe.

// Every input is text: a select's options are its enum.
export type JsonSchemaProperty = {
	type: 'string';
	description: string;
	enum?: string[];
	format?: 'date' | 'date-time';
};

export type JsonSchemaObject = {
	type: 'object';
	properties: Record<string, JsonSchemaProperty>;
	required: string[];
	additionalProperties: false;
};

// What a tool does with its collection: lists it, opens one record, writes one, or runs one of
// its commands on a record (`command`) or on values typed in (`newCommand`).
export type ToolKind = 'list' | 'get' | 'create' | 'update' | 'delete' | 'command' | 'newCommand';

export type Tool = {
	// The collection and what it does, unique within an integration: `emails_archive`.
	name: string;
	// "Archive", "List Email".
	title: string;
	description: string;
	collectionId: string;
	kind: ToolKind;
	// What the activity log calls it, and what `requiredAction` takes: list, view, create, update,
	// delete, or the command's id.
	operation: string;
	// The integration's action it needs.
	action: string;
	// Lists and opens, never changes anything.
	readOnly: boolean;
	risk: Action['risk'];
	reachesOthers: boolean;
	// The records it applies to, when not every one: only drafts are edited or sent.
	where?: Condition;
	inputSchema: JsonSchemaObject;
};

const ID_PROPERTY: JsonSchemaProperty = {
	type: 'string',
	description: 'The record’s id, from a list',
};

// "Inbox", "Draft or Sent", "Inbox, Draft or Sent".
function orList(values: string[]): string {
	if (values.length < 2) {
		return values.join('');
	}
	return `${values.slice(0, -1).join(', ')} or ${values.at(-1)}`;
}

function conditionText(collection: Collection, condition: Condition | undefined): string {
	if (!condition) {
		return '';
	}
	const field = collection.fields.find((candidate) => candidate.key === condition.field);
	return ` Only where ${field?.label ?? condition.field} is ${orList(condition.values)}.`;
}

function fieldProperty(field: Field): JsonSchemaProperty {
	if (field.options) {
		return {type: 'string', description: field.label, enum: field.options};
	}
	if (field.type === 'email') {
		return {type: 'string', description: `${field.label}: one or more addresses, comma-separated`};
	}
	if (field.type === 'date') {
		return {type: 'string', description: `${field.label}, as YYYY-MM-DD`, format: 'date'};
	}
	if (field.type === 'datetime') {
		return {type: 'string', description: field.label, format: 'date-time'};
	}
	return {type: 'string', description: field.label};
}

function objectSchema(
	properties: Record<string, JsonSchemaProperty>,
	required: string[] = [],
): JsonSchemaObject {
	return {type: 'object', properties, required, additionalProperties: false};
}

// The fields a write sets: every one that is typed in rather than set by the provider.
function valueProperties(collection: Collection): Record<string, JsonSchemaProperty> {
	return Object.fromEntries(
		collection.fields
			.filter((field) => !field.system)
			.map((field) => [field.key, fieldProperty(field)]),
	);
}

// `markRead` is `mark_read`.
function snakeCase(id: string): string {
	return id.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

export function toolName(collectionId: string, operation: string): string {
	const suffix = operation === 'view' ? 'get' : snakeCase(operation);
	return `${snakeCase(collectionId)}_${suffix}`;
}

function listSchema(collection: Collection): JsonSchemaObject {
	const properties: Record<string, JsonSchemaProperty> = {};
	if (collection.searchHint) {
		properties.search = {type: 'string', description: collection.searchHint};
	}
	const filter = collection.fields.find((field) => field.key === collection.filterField);
	if (filter?.options) {
		properties[filter.key] = {
			type: 'string',
			description: `Only ${collection.name.toLowerCase()} with this ${filter.label.toLowerCase()}`,
			enum: filter.options,
		};
	}
	properties.page = {
		type: 'string',
		description: 'The nextPage a list gave, for the page after it',
	};
	return objectSchema(properties);
}

function listDescription(collection: Collection): string {
	const search = collection.searchHint ? ' Can be searched.' : '';
	return `List ${collection.name.toLowerCase()}, newest first, a page at a time, with each record’s id for ${toolName(collection.id, 'view')}.${search}`;
}

function collectionTools(integration: Integration, collection: Collection): Tool[] {
	const make = (
		kind: ToolKind,
		operation: string,
		rest: Pick<Tool, 'title' | 'description' | 'inputSchema'> & {where?: Condition},
	): Tool[] => {
		const action = requiredAction(collection, operation);
		const found = integration.actions.find((candidate) => candidate.id === action);
		if (!action || !found) {
			return [];
		}
		const readOnly = kind === 'list' || kind === 'get';
		return [
			{
				name: toolName(collection.id, operation),
				collectionId: collection.id,
				kind,
				operation,
				action,
				readOnly,
				risk: found.risk,
				reachesOthers: found.reachesOthers ?? false,
				...rest,
			},
		];
	};
	const writes = collection.writes;
	const createLabel = collection.createLabel ?? `Create ${collection.singular}`;

	return [
		...make('list', 'list', {
			title: `List ${collection.name}`,
			description: listDescription(collection),
			inputSchema: listSchema(collection),
		}),
		...make('get', 'view', {
			title: `Open ${collection.singular}`,
			description: `Open one ${collection.singular} by its id, with every field.`,
			inputSchema: objectSchema({id: ID_PROPERTY}, ['id']),
		}),
		...(writes.create
			? make('create', 'create', {
					title: createLabel,
					description: `${createLabel}: a new ${collection.singular} from the fields given; any left out are empty.`,
					inputSchema: objectSchema(valueProperties(collection)),
				})
			: []),
		...(writes.update
			? make('update', 'update', {
					title: `Edit ${collection.singular}`,
					description: `Edit a ${collection.singular}: only the fields given change.${conditionText(collection, collection.editable)}`,
					inputSchema: objectSchema({id: ID_PROPERTY, ...valueProperties(collection)}, ['id']),
					where: collection.editable,
				})
			: []),
		...(writes.delete
			? make('delete', 'delete', {
					title: `Delete ${collection.singular}`,
					description: `Delete a ${collection.singular} for good.${conditionText(collection, collection.editable)}`,
					inputSchema: objectSchema({id: ID_PROPERTY}, ['id']),
					where: collection.editable,
				})
			: []),
		...(collection.commands ?? []).flatMap((command) => {
			const action = integration.actions.find((candidate) => candidate.id === command.action);
			const what = action ? ` ${action.description}.` : '';
			if (command.on === 'new') {
				return make('newCommand', command.id, {
					title: command.label,
					description: `${command.label} a new ${collection.singular} from the fields given, without saving it first.${what}`,
					inputSchema: objectSchema(valueProperties(collection)),
				});
			}
			return make('command', command.id, {
				title: command.label,
				description: `${command.label}: one ${collection.singular}, by its id.${what}${conditionText(collection, command.where)}`,
				inputSchema: objectSchema({id: ID_PROPERTY}, ['id']),
				where: command.where,
			});
		}),
	];
}

/** Every tool of an integration, whatever an agent may do. */
export function integrationTools(integration: Integration): Tool[] {
	return integration.collections.flatMap((collection) => collectionTools(integration, collection));
}

export function findTool(integration: Integration, name: string): Tool | undefined {
	return integrationTools(integration).find((tool) => tool.name === name);
}

/** The tools the actions allow, as `effectiveActions` gives them for an agent. */
export function allowedTools(integration: Integration, actions: string[]): Tool[] {
	return integrationTools(integration).filter((tool) => actions.includes(tool.action));
}
