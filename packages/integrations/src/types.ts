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

// One thing an agent can be allowed to do with a connection, set on its own: Read, Archive, Send.
// An action that works on records an agent has to find first names the action that finds them.
export type Action = {
	id: string;
	label: string;
	description: string;
	// How much harm a mistake does, for the person setting it: high is what can't be undone, or
	// reaches other people.
	risk: 'low' | 'medium' | 'high';
	// The action this one only counts with, such as Read for Archive.
	requires?: string;
};

// The records a write or a command applies to, by a field's value: drafts, or emails in the inbox.
export type Condition = {field: string; values: string[]};

// Something done beyond reading and editing, such as archiving an email. `record` commands work
// on one record; `new` ones on values typed in, as sending a new email does. Several commands can
// share an action: Mark as read and Mark as unread both need `mark`.
export type Command = {
	id: string;
	on: 'record' | 'new';
	// The button: "Mark as read".
	label: string;
	action: string;
	// The records it applies to, when not every one.
	where?: Condition;
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
	// A select field the list can be narrowed by, such as an email's folder.
	filterField?: string;
	// What the search takes, told to the agent beside the search box.
	searchHint: string;
	// The integration's action listing and opening records needs.
	read: string;
	// The button creating a record, when not Create and the singular: Save as draft.
	createLabel?: string;
	// The action creating, editing and deleting a record each needs. One left out isn't offered.
	writes: {create?: string; update?: string; delete?: string};
	// The records editing and deleting apply to, when not every one: only drafts can be edited.
	editable?: Condition;
	commands?: Command[];
};

export type IntegrationId = 'info' | 'email';

export type Integration = {
	id: IntegrationId;
	name: string;
	description: string;
	// Everything an agent can be allowed with a connection of it, in the order it is shown.
	actions: Action[];
	collections: Collection[];
	// Information lives in Personal Agent Proxy itself: it is always there and never connected or
	// disconnected.
	builtIn?: boolean;
};
