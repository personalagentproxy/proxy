import type {Experiment} from '@proxy/utils';

import type {McpTool} from './mcp-tools';

// `secret` reads like text but is masked to its last four characters wherever a row summarizes it.
export type FieldType = 'text' | 'longtext' | 'email' | 'datetime' | 'date' | 'select' | 'secret';

export type Field = {
	key: string;
	label: string;
	type: FieldType;
	options?: string[];
	// Set by the provider rather than typed in, such as when an email arrived: shown, never edited.
	system?: boolean;
	// The action writing it needs beyond the collection's write: creating or editing a record where
	// it holds anything, before the write or after it, as an event's guests need Invite guests.
	action?: string;
};

// One thing an agent can be allowed to do with a connection, set on its own: Read, Archive, Send.
// An action that works on records an agent has to find first names the action that finds them.
export type Action = {
	id: string;
	label: string;
	description: string;
	// How much harm a mistake does, for the person setting it: high is what can't be undone, or
	// reaches other people. Unknown is a custom MCP server's tool that says nothing about itself:
	// it starts off, and is shown without a label rather than as any of the others.
	risk: 'low' | 'medium' | 'high' | 'unknown';
	// The action this one only counts with, such as Read for Archive.
	requires?: string;
	// Reaches people beyond the account, as sending email does.
	reachesOthers?: true;
	// The part of the provider it belongs to, as Google's actions are Gmail's, Calendar's, Drive's or
	// Contacts': a connection's permissions show each group's actions under its name.
	group?: string;
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
	// Changes nothing, as running a read-only query doesn't: an MCP client may run it as a read.
	readOnly?: true;
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
	// What the search takes, told to the agent beside the search box. A collection without one
	// can't be searched, as Granola's notes can't.
	searchHint?: string;
	// Records hold others of the collection, as a Notion page holds its subpages or a folder its
	// files: a list opens at one of them with `?parent=`, and a record made there goes in it.
	nested?: boolean;
	// Listed from now on, soonest first, as a calendar's events are, rather than newest first: a
	// list's next page is later rather than older.
	upcoming?: true;
	// A list's rows show every field a record has, under its title, rather than one beside it: for
	// records read like a statement's lines, as a bank's transactions are, all of whose fields are
	// short.
	listsAll?: true;
	// Where a record's own address opens, for its link: "Open in Gmail". A collection whose records
	// have no address the person can open, as a mailbox's over IMAP haven't, has none.
	openIn?: string;
	// The integration's action listing and opening records needs. A collection without one is
	// never listed or opened: a query's results are only ever run.
	read?: string;
	// The button creating a record, when not Create and the singular: Save as draft.
	createLabel?: string;
	// The action creating, editing and deleting a record each needs. One left out isn't offered.
	writes: {create?: string; update?: string; delete?: string};
	// The records editing and deleting apply to, when not every one: only drafts can be edited.
	editable?: Condition;
	commands?: Command[];
};

export type IntegrationId =
	| 'info'
	| 'email'
	| 'granola'
	| 'notion'
	| 'linear'
	| 'postgres'
	| 'mysql'
	| 'mcp'
	| 'google'
	| 'plaid';

export type Integration = {
	id: IntegrationId;
	name: string;
	description: string;
	// Everything an agent can be allowed with a connection of it, in the order it is shown.
	actions: Action[];
	collections: Collection[];
	// Shown above a connection's permissions: what ticking them hands the person's agents, where a
	// provider's policy asks for it to be said.
	disclosure?: string;
	// Information lives in Personal Agent Proxy itself: it is always there and never connected or
	// disconnected.
	builtIn?: boolean;
	// A custom MCP server: its actions are a connection's own tools, so the catalog's entry has
	// none, and `integrationFor` fills them in from the connection.
	custom?: true;
	// The tools of the connection a custom integration was built for, each a tool of its own.
	mcpTools?: McpTool[];
	// The experiment an organization needs on to connect it: the catalog, the api's routes and the
	// MCP server's instructions all leave it out without. Connections already made keep working.
	experiment?: Experiment;
};
