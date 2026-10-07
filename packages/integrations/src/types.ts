// `secret` reads like text but is masked to its last four characters wherever a row summarizes it.
export type FieldType = 'text' | 'longtext' | 'email' | 'datetime' | 'date' | 'select' | 'secret';

export type Field = {
	key: string;
	label: string;
	type: FieldType;
	options?: string[];
	// Set by the provider rather than typed in, such as when an email arrived: shown, never edited.
	system?: boolean;
};

export type Access = 'none' | 'read' | 'write';

export type WriteAction = 'create' | 'update' | 'delete';

export type Collection = {
	id: string;
	name: string;
	// One record of the collection, lowercase, for the audit log: "Viewed email …".
	singular: string;
	fields: Field[];
	// The field a row shows as its title, and the one it shows beside it.
	titleField: string;
	summaryField?: string;
	// The changes the provider takes, when not every one: none for received emails, only create
	// for sent ones.
	writeActions?: WriteAction[];
	// How creating a record reads where it isn't "Create": Send for an email.
	createVerb?: {present: string; past: string};
};

export type IntegrationId = 'info' | 'email';

export type Integration = {
	id: IntegrationId;
	name: string;
	description: string;
	collections: Collection[];
	// Information lives in Personal Agent Proxy itself: it is always there and never connected or
	// disconnected.
	builtIn?: boolean;
};
