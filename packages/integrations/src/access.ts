import type {Access, Collection} from './types';

export const ACCESS_LEVELS: Access[] = ['none', 'read', 'write'];

export function isAccess(value: string): value is Access {
	return ACCESS_LEVELS.some((level) => level === value);
}

export function minAccess(a: Access, b: Access): Access {
	return ACCESS_LEVELS.indexOf(a) < ACCESS_LEVELS.indexOf(b) ? a : b;
}

// What the provider allows in a collection. Received emails can only be read.
export function providerAccess(collection: Collection): Access {
	if (collection.readOnly) {
		return 'read';
	}
	return 'write';
}

// Access is set in three layers: what the provider allows, the connection's default, and an
// agent's own setting where it differs from the default. A stored setting above the provider is
// kept but capped, so it applies again once the provider allows it.
export function effectiveAccess(layers: {
	provider: Access;
	connectionDefault: Access;
	agent: Access | null;
}): Access {
	return minAccess(layers.agent ?? layers.connectionDefault, layers.provider);
}
