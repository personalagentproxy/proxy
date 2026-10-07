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

// One thing an agent can be allowed to do in a collection, set on its own: Read, Write drafts,
// Send. Every collection has `read`, and every other action needs it, since an agent can't act on
// a record it can't find.
export type Action = {
	id: string;
	label: string;
	description: string;
	// How much harm a mistake does, for the person setting it: high is what can't be undone, or
	// reaches other people.
	risk: 'low' | 'medium' | 'high';
};

// A named set of actions, such as Read & triage: what a folded collection's actions add up to.
// Never stored; actions that match no preset are Custom.
export type Preset = {label: string; actions: string[]};

// Something done to one record beyond reading and editing it, such as archiving an email. Several
// commands can share an action: Mark as read and Mark as unread both need `mark`.
export type Command = {
	id: string;
	// The button: "Mark as read".
	label: string;
	action: string;
	// The activity log's line, `{}` standing for the record: "Marked {} as read", and what a refused
	// one tried: "mark {} as read".
	done: string;
	tried: string;
};

export type Collection = {
	id: string;
	name: string;
	// One record of the collection, lowercase, for the audit log: "Viewed email …".
	singular: string;
	fields: Field[];
	// The field a row shows as its title, and the one it shows beside it.
	titleField: string;
	summaryField?: string;
	// Everything that can be allowed here, in the order it is shown; the first is always `read`.
	actions: Action[];
	// The presets between No access and everything, such as Read & triage.
	presets?: Preset[];
	// The action creating, editing and deleting a record each needs. One left out isn't offered,
	// as received emails can't be created or edited.
	writes: {create?: string; update?: string; delete?: string};
	commands?: Command[];
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
