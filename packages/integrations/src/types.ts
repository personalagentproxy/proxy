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

export type Collection = {
	id: string;
	name: string;
	// One record of the collection, lowercase, for the audit log: "Viewed email …".
	singular: string;
	fields: Field[];
	// The field a row shows as its title, and the one it shows beside it.
	titleField: string;
	summaryField?: string;
	// Records the provider fills in, which can be read but never changed, such as received emails.
	readOnly?: boolean;
};

export type IntegrationId = 'info' | 'email';

export type Integration = {
	id: IntegrationId;
	name: string;
	description: string;
	collections: Collection[];
	// Information lives in Proxy itself: it is always there and never connected or disconnected.
	builtIn?: boolean;
};
