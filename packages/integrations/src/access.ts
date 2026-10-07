import type {Collection, Preset} from './types';

// Access is set per action, in two layers: the connection's default, and an agent's own setting
// where it differs from the default. What can be set at all is what the catalog lists, which is
// what Proxy can do with the provider.

// An agent's own settings for one collection, by action; an action left out follows the default.
export type OwnSettings = Partial<Record<string, boolean>>;

/**
 * What an agent can do in a collection: its own setting for each action, else the default as it
 * is now. Without `read` it can do nothing, since every other action works on a record it found.
 */
export function effectiveActions(
	collection: Collection,
	defaults: string[],
	own: OwnSettings = {},
): string[] {
	const chosen = collection.actions
		.map((action) => action.id)
		.filter((id) => own[id] ?? defaults.includes(id));
	if (!chosen.includes('read')) {
		return [];
	}
	return chosen;
}

export function sameActions(a: string[], b: string[]): boolean {
	return a.length === b.length && a.every((id) => b.includes(id));
}

/** No access, Read, the collection's own presets and Full access, without two of the same. */
export function presetsOf(collection: Collection): Preset[] {
	const all: Preset[] = [
		{label: 'No access', actions: []},
		{label: 'Read', actions: ['read']},
		...(collection.presets ?? []),
		{label: 'Full access', actions: collection.actions.map((action) => action.id)},
	];
	return all.filter(
		(preset, index) =>
			all.findIndex((earlier) => sameActions(earlier.actions, preset.actions)) === index,
	);
}

/** The preset the actions make up, or null for Custom. */
export function matchingPreset(collection: Collection, actions: string[]): Preset | null {
	return presetsOf(collection).find((preset) => sameActions(preset.actions, actions)) ?? null;
}

export type Operation = 'list' | 'view' | 'create' | 'update' | 'delete';

/**
 * The action a request needs: `read` to list or view, the collection's own for a write or a
 * command. Null when the collection doesn't offer it at all.
 */
export function requiredAction(collection: Collection, request: string): string | null {
	if (request === 'list' || request === 'view') {
		return 'read';
	}

	if (request === 'create' || request === 'update' || request === 'delete') {
		return collection.writes[request] ?? null;
	}

	return collection.commands?.find((command) => command.id === request)?.action ?? null;
}
