import type {Action, Collection, Condition, Integration} from './types';

const INBOX: Condition = {field: 'folder', values: ['Inbox']};

export const INFO_INTEGRATION_ID = 'info';

// The actions an email collection's reads, writes and commands need, by what they do.
type EmailActions = {
	read: string;
	mark: string;
	flag: string;
	archive: string;
	write: string;
	trash: string;
	send: string;
};

// What flagging is called: Flag on any mailbox, Star on Gmail.
type FlagWords = {flag: string; unflag: string; flagged: string; unflagged: string};

const FLAG: FlagWords = {
	flag: 'Flag',
	unflag: 'Unflag',
	flagged: 'Flagged',
	unflagged: 'Unflagged',
};
const STAR: FlagWords = {
	flag: 'Star',
	unflag: 'Unstar',
	flagged: 'Starred',
	unflagged: 'Unstarred',
};

/**
 * A mailbox's email as one collection, the same for any mailbox and for Gmail, so agents see one
 * kind of email: the same fields and commands, under each integration's own action ids. Drafts
 * are the only email edited or deleted; commands act on email in the inbox.
 */
function emailsCollection(args: {
	actions: EmailActions;
	folders: string[];
	searchHint: string;
	flag: FlagWords;
	openIn?: string;
}): Collection {
	const {actions, flag} = args;
	return {
		id: 'emails',
		name: 'Email',
		singular: 'email',
		titleField: 'subject',
		summaryField: 'from',
		filterField: 'folder',
		searchHint: args.searchHint,
		...(args.openIn ? {openIn: args.openIn} : {}),
		read: actions.read,
		createLabel: 'Save as draft',
		writes: {create: actions.write, update: actions.write, delete: actions.write},
		editable: {field: 'folder', values: ['Draft']},
		commands: [
			{
				id: 'markRead',
				on: 'record',
				label: 'Mark as read',
				action: actions.mark,
				where: INBOX,
				done: 'Marked {} as read',
				tried: 'mark {} as read',
			},
			{
				id: 'markUnread',
				on: 'record',
				label: 'Mark as unread',
				action: actions.mark,
				where: INBOX,
				done: 'Marked {} as unread',
				tried: 'mark {} as unread',
			},
			{
				id: 'flag',
				on: 'record',
				label: flag.flag,
				action: actions.flag,
				where: INBOX,
				done: `${flag.flagged} {}`,
				tried: `${flag.flag.toLowerCase()} {}`,
			},
			{
				id: 'unflag',
				on: 'record',
				label: flag.unflag,
				action: actions.flag,
				where: INBOX,
				done: `${flag.unflagged} {}`,
				tried: `${flag.unflag.toLowerCase()} {}`,
			},
			{
				id: 'archive',
				on: 'record',
				label: 'Archive',
				action: actions.archive,
				where: INBOX,
				done: 'Archived {}',
				tried: 'archive {}',
			},
			{
				id: 'trash',
				on: 'record',
				label: 'Move to Trash',
				action: actions.trash,
				where: INBOX,
				done: 'Moved {} to Trash',
				tried: 'move {} to Trash',
			},
			{
				id: 'send',
				on: 'record',
				label: 'Send',
				action: actions.send,
				where: {field: 'folder', values: ['Draft']},
				done: 'Sent {}',
				tried: 'send {}',
			},
			{
				id: 'sendNew',
				on: 'new',
				label: 'Send',
				action: actions.send,
				done: 'Sent {}',
				tried: 'send {}',
			},
		],
		fields: [
			{
				key: 'folder',
				label: 'Folder',
				type: 'select',
				options: args.folders,
				system: true,
			},
			{key: 'from', label: 'From', type: 'email', system: true},
			{key: 'to', label: 'To', type: 'email'},
			{key: 'subject', label: 'Subject', type: 'text'},
			{key: 'date', label: 'Date', type: 'datetime', system: true},
			// "Unread, Flagged" ("Unread, Starred" on Gmail), for an email in the inbox.
			{key: 'status', label: 'Status', type: 'text', system: true},
			{key: 'body', label: 'Body', type: 'longtext'},
		],
	};
}

// Any mailbox over IMAP and SMTP, signed in with an app password. The password can't be limited,
// so access is only ever narrowed in Personal Agent Proxy. The inbox, drafts and sent mail are one
// list, each email saying which folder it is in. Received emails are never edited or deleted for
// good: they are marked, flagged, archived or moved to Trash. Sending needs nothing else, so an
// agent can send without reading the mailbox.
const email: Integration = {
	id: 'email',
	name: 'Email',
	description: 'Gmail, iCloud, Fastmail or any IMAP mailbox',
	actions: [
		{
			id: 'read',
			label: 'Read',
			description: 'List and open emails, drafts and sent mail',
			risk: 'low',
		},
		{
			id: 'mark',
			label: 'Mark read or unread',
			description: 'Mark emails in the inbox read or unread',
			risk: 'low',
			requires: 'read',
		},
		{
			id: 'flag',
			label: 'Flag',
			description: 'Flag and unflag emails in the inbox',
			risk: 'low',
			requires: 'read',
		},
		{
			id: 'archive',
			label: 'Archive',
			description: 'Move emails out of the inbox into the archive',
			risk: 'medium',
			requires: 'read',
		},
		{
			id: 'write',
			label: 'Write drafts',
			description: 'Create, edit and delete drafts',
			risk: 'medium',
			requires: 'read',
		},
		{
			id: 'trash',
			label: 'Move to Trash',
			description: 'Move emails to Trash, where they can be restored from',
			risk: 'high',
			requires: 'read',
		},
		{
			id: 'send',
			label: 'Send',
			description: 'Send email from this address, new or from a draft',
			risk: 'high',
			reachesOthers: true,
		},
	],
	collections: [
		emailsCollection({
			actions: {
				read: 'read',
				mark: 'mark',
				flag: 'flag',
				archive: 'archive',
				write: 'write',
				trash: 'trash',
				send: 'send',
			},
			folders: ['Inbox', 'Draft', 'Sent'],
			searchHint:
				'On Gmail, Gmail’s own search syntax works, such as from:sam has:attachment newer_than:7d. Other mailboxes match the words in the sender, recipients, subject and text.',
			flag: FLAG,
		}),
	],
};

// Granola's meeting notes, read through its MCP server after signing in to Granola. Granola only
// lets them be read, and its sign-in can't be limited to notes or transcripts, so access is
// narrowed in Personal Agent Proxy: the notes (the summary Granola writes and the owner's own
// notes) and the transcripts, word for word, are each a collection of the same meetings with an
// action of its own. Granola's free plan has no transcripts and only the last 30 days of notes.
// There is no search.
const granola: Integration = {
	id: 'granola',
	name: 'Granola',
	description: 'Meeting notes and transcripts',
	actions: [
		{
			id: 'readNotes',
			label: 'Read notes',
			description: 'List and open meeting notes: attendees, the summary and your own notes',
			risk: 'low',
		},
		{
			id: 'readTranscripts',
			label: 'Read transcripts',
			description: 'List and open meetings word for word, with who said what',
			risk: 'medium',
		},
	],
	collections: [
		{
			id: 'notes',
			name: 'Notes',
			singular: 'note',
			titleField: 'title',
			summaryField: 'date',
			openIn: 'Granola',
			read: 'readNotes',
			writes: {},
			fields: [
				{key: 'title', label: 'Title', type: 'text', system: true},
				// As Granola writes it, in the account's time zone: "Sep 22, 2026 11:00 AM PDT".
				{key: 'date', label: 'Date', type: 'text', system: true},
				// As Granola writes them: "Alex (note creator) from Acme <alex@acme.com>, Sam <sam@example.com>".
				{key: 'attendees', label: 'Attendees', type: 'text', system: true},
				{key: 'summary', label: 'Summary', type: 'longtext', system: true},
				{key: 'privateNotes', label: 'Private notes', type: 'longtext', system: true},
			],
		},
		{
			id: 'transcripts',
			name: 'Transcripts',
			singular: 'transcript',
			titleField: 'title',
			summaryField: 'date',
			openIn: 'Granola',
			read: 'readTranscripts',
			writes: {},
			fields: [
				{key: 'title', label: 'Title', type: 'text', system: true},
				{key: 'date', label: 'Date', type: 'text', system: true},
				// Granola's own lines, by where the audio came from: "Microphone: …", "System audio: …".
				{key: 'transcript', label: 'Transcript', type: 'longtext', system: true},
			],
		},
	],
};

// A Notion account's pages, through Notion's MCP server, as the person who signed in: every page
// they can see in the workspace they chose, as a tree. Pages hold pages and databases, databases
// their rows, or their saved views when they have several, and views the rows they show. A row is
// a page, its properties written out beside its content. New pages are private to the person
// until they move them, unless made inside a page or database; edits reach whoever the page is
// shared with. Pages aren't deleted.
const notion: Integration = {
	id: 'notion',
	name: 'Notion',
	description: 'Pages and database rows in a workspace',
	actions: [
		{
			id: 'read',
			label: 'Read pages',
			description: 'List, search and open pages and databases, and the rows in them',
			risk: 'low',
		},
		{
			id: 'create',
			label: 'Create pages',
			description: 'Add pages inside pages and rows to databases, or private pages of your own',
			risk: 'medium',
		},
		{
			id: 'edit',
			label: 'Edit pages',
			description:
				'Change the title, properties and content of pages, as whoever they are shared with sees them',
			risk: 'high',
			requires: 'read',
		},
	],
	collections: [
		{
			id: 'pages',
			name: 'Pages',
			singular: 'page',
			titleField: 'title',
			summaryField: 'path',
			searchHint:
				'Notion’s own search: words in titles and content, or what a page is about. Inside a page or database, only what is in it.',
			nested: true,
			openIn: 'Notion',
			read: 'read',
			writes: {create: 'create', update: 'edit'},
			// Databases and their views aren't written to; their rows are pages.
			editable: {field: 'kind', values: ['Page']},
			fields: [
				{key: 'title', label: 'Title', type: 'text'},
				{
					key: 'kind',
					label: 'Kind',
					type: 'select',
					options: ['Page', 'Database', 'View'],
					system: true,
				},
				// Where the page is: "Outreach / Companies".
				{key: 'path', label: 'In', type: 'text', system: true},
				{key: 'edited', label: 'Last edited', type: 'datetime', system: true},
				// A database row's properties, one "Name: value" a line, a value going on over the lines
				// after it until the next property. Only properties written differently are changed.
				{key: 'properties', label: 'Properties', type: 'longtext'},
				// Notion-flavored Markdown, child pages and databases as <page> and <database> tags.
				{key: 'content', label: 'Content', type: 'longtext'},
			],
		},
	],
};

// The kinds of status every Linear team's own statuses are one of, as the list is narrowed by.
export const LINEAR_STATUS_TYPES = [
	'Triage',
	'Backlog',
	'Unstarted',
	'Started',
	'Completed',
	'Canceled',
	'Duplicate',
];

// Linear's priorities, from its numbers 0 to 4.
export const LINEAR_PRIORITIES = ['No priority', 'Urgent', 'High', 'Medium', 'Low'];

// A Linear workspace's issues, through Linear's MCP server, as the person who signed in: what an
// agent writes shows as theirs. A sign-in is for one workspace and can't be limited, so access is
// narrowed in Personal Agent Proxy. Teams, statuses, people, projects and labels are written by
// name, as Linear shows them, and an issue's comments are read with it. Linear's MCP server has no
// tool that archives or deletes an issue, so issues aren't deleted.
const linear: Integration = {
	id: 'linear',
	name: 'Linear',
	description: 'Issues in a workspace',
	actions: [
		{
			id: 'read',
			label: 'Read issues',
			description: 'List, search and open issues, with their comments',
			risk: 'low',
		},
		{
			id: 'create',
			label: 'Create issues',
			description: 'Add issues to a team, assigned to anyone in the workspace',
			risk: 'medium',
		},
		{
			id: 'edit',
			label: 'Edit issues',
			description: 'Change the title, description, status, assignee and other fields of issues',
			risk: 'medium',
			requires: 'read',
		},
	],
	collections: [
		{
			id: 'issues',
			name: 'Issues',
			singular: 'issue',
			titleField: 'title',
			summaryField: 'status',
			filterField: 'statusType',
			searchHint: 'Words in an issue’s title or description.',
			openIn: 'Linear',
			read: 'read',
			writes: {create: 'create', update: 'edit'},
			fields: [
				{key: 'title', label: 'Title', type: 'text'},
				// The team's name or key, "Engineering" or "ENG"; moving an issue to another gives it a new id.
				{key: 'team', label: 'Team', type: 'text'},
				// One of the team's statuses, "In Progress", or a type of them, "started".
				{key: 'status', label: 'Status', type: 'text'},
				{
					key: 'statusType',
					label: 'Status type',
					type: 'select',
					options: LINEAR_STATUS_TYPES,
					system: true,
				},
				{key: 'priority', label: 'Priority', type: 'select', options: LINEAR_PRIORITIES},
				// Someone in the workspace by name or email, or "me" for whoever signed in.
				{key: 'assignee', label: 'Assignee', type: 'text'},
				{key: 'project', label: 'Project', type: 'text'},
				// Comma-separated names, "Bug, Frontend"; written, they replace every label.
				{key: 'labels', label: 'Labels', type: 'text'},
				{key: 'dueDate', label: 'Due date', type: 'date'},
				{key: 'createdBy', label: 'Created by', type: 'text', system: true},
				{key: 'updated', label: 'Updated', type: 'datetime', system: true},
				// Markdown.
				{key: 'description', label: 'Description', type: 'longtext'},
				// Oldest first, each its author and time, then what they wrote.
				{key: 'comments', label: 'Comments', type: 'longtext', system: true},
			],
		},
	],
};

// A SQL database, signed in to with a database user's name and password: PostgreSQL, or MySQL
// and MariaDB. What the user may do in the database is the limit, so access is narrowed in
// Personal Agent Proxy: the tables and their rows are one tree, a table holding its rows, and a
// query runs read-only SQL, one statement at a time, inside a read-only transaction. A row is
// written as "column: value" lines and found again by its primary key; a table without one is
// read but never written to. Nothing is copied: every request runs in the database.
function sqlIntegration(id: 'postgres' | 'mysql', name: string, description: string): Integration {
	return {
		id,
		name,
		description,
		actions: [
			{
				id: 'read',
				label: 'Read tables',
				description: 'List tables, their columns and their rows, and search rows',
				risk: 'low',
			},
			{
				id: 'query',
				label: 'Run queries',
				description:
					'Run read-only SQL, one SELECT, WITH, SHOW or EXPLAIN at a time, in a read-only transaction',
				risk: 'low',
			},
			{
				id: 'insert',
				label: 'Add rows',
				description: 'Insert rows into tables',
				risk: 'medium',
				requires: 'read',
			},
			{
				id: 'update',
				label: 'Edit rows',
				description: 'Change the values of rows, found by their primary key',
				risk: 'high',
				requires: 'read',
			},
			{
				id: 'delete',
				label: 'Delete rows',
				description: 'Delete rows for good, found by their primary key',
				risk: 'high',
				requires: 'read',
			},
		],
		collections: [
			{
				id: 'tables',
				name: 'Tables',
				singular: 'row',
				titleField: 'name',
				summaryField: 'summary',
				searchHint:
					'At the top, words in table names. Inside a table, rows with every word somewhere in their columns.',
				nested: true,
				read: 'read',
				createLabel: 'Add row',
				writes: {create: 'insert', update: 'update', delete: 'delete'},
				editable: {field: 'kind', values: ['Row']},
				fields: [
					// A table's name with its schema, "public.users"; a row's table and primary key, "users 42".
					{key: 'name', label: 'Name', type: 'text', system: true},
					{
						key: 'kind',
						label: 'Kind',
						type: 'select',
						options: ['Table', 'View', 'Row'],
						system: true,
					},
					// A table's size, "about 1,204 rows, 8 columns"; a row's first values.
					{key: 'summary', label: 'Summary', type: 'text', system: true},
					// A table's columns, one a line: "email text not null", "id integer primary key".
					{key: 'columns', label: 'Columns', type: 'longtext', system: true},
					// A row's values, one "column: value" a line, a value going on over the lines after it
					// until the next column. An empty value is NULL. Only columns written differently change,
					// and a column left out of a new row takes its default.
					{key: 'values', label: 'Values', type: 'longtext'},
				],
			},
			{
				id: 'queries',
				name: 'Queries',
				singular: 'query',
				titleField: 'sql',
				writes: {},
				commands: [
					{
						id: 'run',
						on: 'new',
						label: 'Run',
						action: 'query',
						readOnly: true,
						done: 'Ran {}',
						tried: 'run {}',
					},
				],
				fields: [
					{key: 'sql', label: 'SQL', type: 'longtext'},
					// "12 rows", or "200 rows, more left out".
					{key: 'rows', label: 'Rows', type: 'text', system: true},
					// One row a line, as JSON: {"id": 42, "email": "alex@example.com"}.
					{key: 'result', label: 'Result', type: 'longtext', system: true},
				],
			},
		],
	};
}

const postgres = sqlIntegration(
	'postgres',
	'PostgreSQL',
	'Tables and queries in a Postgres database',
);

const mysql = sqlIntegration('mysql', 'MySQL', 'Tables and queries in a MySQL or MariaDB database');

// The answers to an invitation, on an event someone else invited the account to; empty on the
// account's own events.
const INVITED: Condition = {
	field: 'response',
	values: ['Needs action', 'Accepted', 'Declined', 'Maybe'],
};

// What a Drive record can be beside a place: a spreadsheet holds its tabs (Sheet), a tab its rows.
const FILE_KINDS = ['Folder', 'Document', 'Spreadsheet', 'Presentation', 'Sheet', 'Row', 'File'];

// A Google account, signed in to once for everything Personal Agent Proxy reads and writes there:
// Gmail, Calendar, Drive, Docs, Sheets, Slides and Contacts. One connection holds every product, so
// action ids carry the product, as Information's `readCards` and `writeCards` do, and each action
// names its product as its group. Gmail is the same email as any mailbox's, its labels as folders:
// all mail but Spam and Trash in one list, narrowed to the inbox, drafts, sent mail, the archive,
// Trash or Spam. Drafts are the only email edited or deleted; nothing else is deleted for good, only
// moved to Trash. Calendar is one tree of the calendars and their events. Drive is one tree: My
// Drive, Shared with me, Shared drives and Recent at the top, folders holding files, a spreadsheet
// holding its tabs and a tab its rows. Documents read as Markdown, presentations as text, rows as
// "Header: value" lines; new documents are written as Markdown and new spreadsheets as CSV, which
// Drive converts, and a spreadsheet's ranges are read and written in A1 notation as CSV. Files are
// moved to Trash, never deleted, and neither are events or contacts. Nothing is copied: every
// request goes to Google.
const google: Integration = {
	id: 'google',
	name: 'Google',
	description: 'Gmail, Calendar, Drive, Docs, Sheets, Slides and Contacts for one Google account',
	// Google's Limited Use policy asks for what happens with its data to be said where access is given.
	disclosure: 'What is ticked here is what your agents can read and do with this Google account.',
	actions: [
		{
			id: 'readEmails',
			label: 'Read email',
			description: 'List, search and open email in Gmail, drafts and sent mail included',
			risk: 'low',
			group: 'Gmail',
		},
		{
			id: 'markEmails',
			label: 'Mark read or unread',
			description: 'Mark emails in the inbox read or unread',
			risk: 'low',
			requires: 'readEmails',
			group: 'Gmail',
		},
		{
			id: 'flagEmails',
			label: 'Star',
			description: 'Star and unstar emails in the inbox',
			risk: 'low',
			requires: 'readEmails',
			group: 'Gmail',
		},
		{
			id: 'archiveEmails',
			label: 'Archive',
			description: 'Move emails out of the inbox, keeping them in All Mail',
			risk: 'medium',
			requires: 'readEmails',
			group: 'Gmail',
		},
		{
			id: 'writeEmails',
			label: 'Write drafts',
			description: 'Create, edit and delete drafts',
			risk: 'medium',
			requires: 'readEmails',
			group: 'Gmail',
		},
		{
			id: 'trashEmails',
			label: 'Move email to Trash',
			description: 'Move emails to Trash, where Gmail keeps them 30 days before deleting them',
			risk: 'high',
			requires: 'readEmails',
			group: 'Gmail',
		},
		{
			id: 'sendEmails',
			label: 'Send',
			description: 'Send email from this address, new or from a draft',
			risk: 'high',
			reachesOthers: true,
			group: 'Gmail',
		},
		{
			id: 'readEvents',
			label: 'Read events',
			description: 'See your calendars, and list, search and open their events',
			risk: 'low',
			group: 'Calendar',
		},
		{
			id: 'writeEvents',
			label: 'Create and edit events',
			description: 'Create events and change them, on calendars you can edit',
			risk: 'medium',
			requires: 'readEvents',
			group: 'Calendar',
		},
		{
			id: 'respondEvents',
			label: 'Answer invitations',
			description: 'Accept or decline invitations, or answer maybe; the organizer is told',
			risk: 'medium',
			requires: 'readEvents',
			reachesOthers: true,
			group: 'Calendar',
		},
		{
			id: 'inviteGuests',
			label: 'Invite guests',
			description:
				'Invite people to events and change events that have guests; Google emails them each invitation and change',
			risk: 'high',
			requires: 'writeEvents',
			reachesOthers: true,
			group: 'Calendar',
		},
		{
			id: 'readFiles',
			label: 'Read files',
			description:
				'Browse and search Drive, and open files, documents, spreadsheets and presentations',
			risk: 'low',
			group: 'Drive',
		},
		{
			id: 'createFiles',
			label: 'Create files',
			description: 'Create folders, documents and spreadsheets, and add rows',
			risk: 'medium',
			requires: 'readFiles',
			group: 'Drive',
		},
		{
			id: 'editFiles',
			label: 'Edit files',
			description: 'Rename files, replace a document’s content and change rows and ranges',
			risk: 'medium',
			requires: 'readFiles',
			group: 'Drive',
		},
		{
			id: 'trashFiles',
			label: 'Move files to Trash',
			description:
				'Move files and folders to Trash, where Drive keeps them 30 days before deleting them',
			risk: 'high',
			requires: 'readFiles',
			group: 'Drive',
		},
		{
			id: 'readContacts',
			label: 'Read contacts',
			description: 'List, search and open your contacts',
			risk: 'low',
			group: 'Contacts',
		},
		{
			id: 'writeContacts',
			label: 'Add and edit contacts',
			description: 'Add contacts and change their details',
			risk: 'medium',
			requires: 'readContacts',
			group: 'Contacts',
		},
	],
	collections: [
		emailsCollection({
			actions: {
				read: 'readEmails',
				mark: 'markEmails',
				flag: 'flagEmails',
				archive: 'archiveEmails',
				write: 'writeEmails',
				trash: 'trashEmails',
				send: 'sendEmails',
			},
			// The archive is what is in none of the others: All Mail without the inbox.
			folders: ['Inbox', 'Draft', 'Sent', 'Archive', 'Trash', 'Spam'],
			searchHint:
				'Gmail’s own search syntax, as in Gmail’s search box, such as from:sam has:attachment newer_than:7d. Inside a folder, only what is in it.',
			flag: STAR,
			openIn: 'Gmail',
		}),
		// The calendars the account sees, each holding its events: from now on, soonest first, every
		// time a repeating event comes round its own record. Times are written as Google takes them,
		// 2026-10-15T14:00 in the calendar's time zone or with an offset, and a day alone, 2026-10-15,
		// for an all-day event, whose end is its last day. An event with guests reaches them: inviting
		// them, and any change once they are invited, needs Invite guests, and Google emails them.
		{
			id: 'events',
			name: 'Events',
			singular: 'event',
			titleField: 'title',
			summaryField: 'start',
			searchHint:
				'Words in an event’s title, description, location or guests, from now on. Begin with a day, such as 2026-10-15 standup, for the events from that day on, earlier ones too. At the top, in the primary calendar.',
			nested: true,
			upcoming: true,
			openIn: 'Google Calendar',
			read: 'readEvents',
			writes: {create: 'writeEvents', update: 'writeEvents'},
			// Calendars are only read.
			editable: {field: 'kind', values: ['Event']},
			commands: [
				{
					id: 'accept',
					on: 'record',
					label: 'Accept',
					action: 'respondEvents',
					where: INVITED,
					done: 'Accepted {}',
					tried: 'accept {}',
				},
				{
					id: 'decline',
					on: 'record',
					label: 'Decline',
					action: 'respondEvents',
					where: INVITED,
					done: 'Declined {}',
					tried: 'decline {}',
				},
				{
					id: 'maybe',
					on: 'record',
					label: 'Maybe',
					action: 'respondEvents',
					where: INVITED,
					done: 'Answered maybe to {}',
					tried: 'answer maybe to {}',
				},
			],
			fields: [
				{key: 'title', label: 'Title', type: 'text'},
				{key: 'kind', label: 'Kind', type: 'select', options: ['Calendar', 'Event'], system: true},
				{key: 'start', label: 'Start', type: 'text'},
				// Left out of a new event, an hour after the start, or the start's day for an all-day one.
				{key: 'end', label: 'End', type: 'text'},
				{key: 'location', label: 'Location', type: 'text'},
				// Everyone invited but the account itself and the rooms booked, by their addresses.
				{key: 'guests', label: 'Guests', type: 'email', action: 'inviteGuests'},
				{key: 'description', label: 'Description', type: 'longtext'},
				// Each guest's answer, one a line: "Sam Lee <sam@example.com>: Accepted".
				{key: 'answers', label: 'Guests’ answers', type: 'longtext', system: true},
				// The account's own answer, on an event someone else invited it to.
				{
					key: 'response',
					label: 'Your answer',
					type: 'select',
					options: INVITED.values,
					system: true,
				},
				// Whoever organizes the event, when it isn't the account.
				{key: 'organizer', label: 'Organizer', type: 'text', system: true},
				// "Every week", for an event that repeats; each time it comes round is changed on its own.
				{key: 'repeats', label: 'Repeats', type: 'text', system: true},
				// The video call's address, where the event has one.
				{key: 'meeting', label: 'Video call', type: 'text', system: true},
			],
		},
		{
			id: 'files',
			name: 'Files',
			singular: 'file',
			titleField: 'name',
			summaryField: 'kind',
			searchHint:
				'Words in file names and contents, anywhere in Drive, or inside the folder opened.',
			nested: true,
			openIn: 'Google Drive',
			read: 'readFiles',
			writes: {create: 'createFiles', update: 'editFiles'},
			// The four places at the top are always there, as they are.
			editable: {field: 'kind', values: FILE_KINDS},
			commands: [
				{
					id: 'trash',
					on: 'record',
					label: 'Move to Trash',
					action: 'trashFiles',
					// A spreadsheet's tabs and rows aren't files of their own.
					where: {
						field: 'kind',
						values: FILE_KINDS.filter((kind) => kind !== 'Sheet' && kind !== 'Row'),
					},
					done: 'Moved {} to Trash',
					tried: 'move {} to Trash',
				},
			],
			fields: [
				{key: 'name', label: 'Name', type: 'text'},
				// What a record is, and what a new one is to be: a folder, document or spreadsheet inside a
				// folder or a place, or a row inside a tab, where it can be left out. It can't be changed.
				{
					key: 'kind',
					label: 'Kind',
					type: 'select',
					// A place is one of the four at the top: My Drive, Shared with me, Shared drives, Recent.
					// A shared drive holds files as a folder does, but isn't renamed or trashed here.
					options: ['Place', 'Shared drive', ...FILE_KINDS],
				},
				{key: 'modified', label: 'Modified', type: 'datetime', system: true},
				// Whoever owns the file in Drive; files in a shared drive have none.
				{key: 'owner', label: 'Owner', type: 'text', system: true},
				// A document as Markdown, a presentation as text, a spreadsheet's tabs one a line with their
				// size, a row's values one "Header: value" a line, the headers from the tab's first row. A
				// new document is written as Markdown and a new spreadsheet as CSV. Writing a document's
				// content replaces all of it, dropping its comments and suggestions; a row's changes only
				// the headers written differently. A presentation's and a spreadsheet's are only read.
				{key: 'content', label: 'Content', type: 'longtext'},
			],
		},
		// A range of a spreadsheet, read or written in A1 notation, as people who know Sheets think of
		// one, and for tabs without a header row. Never listed or opened, only run.
		{
			id: 'ranges',
			name: 'Ranges',
			singular: 'range',
			titleField: 'range',
			writes: {},
			commands: [
				{
					id: 'read',
					on: 'new',
					label: 'Read',
					action: 'readFiles',
					readOnly: true,
					done: 'Read {}',
					tried: 'read {}',
				},
				{
					id: 'write',
					on: 'new',
					label: 'Write',
					action: 'editFiles',
					done: 'Wrote {}',
					tried: 'write {}',
				},
			],
			fields: [
				// The spreadsheet's id, or its link.
				{key: 'spreadsheet', label: 'Spreadsheet', type: 'text'},
				// A1 notation, with the tab or in the first one: 'Q1 Sales'!A1:F20, A1:F20.
				{key: 'range', label: 'Range', type: 'text'},
				// What Write puts in the range, as CSV, one row a line, each value as if typed into the
				// cell: =SUM(B2:B9) is a formula.
				{key: 'values', label: 'Values', type: 'longtext'},
				// "12 rows", or how many of more were answered: at most 1000.
				{key: 'rows', label: 'Rows', type: 'text', system: true},
				// The range's values as Sheets shows them, as CSV, one row a line: after Write, as written.
				{key: 'result', label: 'Result', type: 'longtext', system: true},
			],
		},
		// The account's contacts in Google Contacts, newest changed first. Emails and phone numbers are
		// comma-separated, addresses one a line; a contact's birthday is 1990-04-12, or 04-12 without
		// the year. Contacts are never deleted here.
		{
			id: 'contacts',
			name: 'Contacts',
			singular: 'contact',
			titleField: 'name',
			summaryField: 'emails',
			searchHint:
				'The start of a name, email address, phone number or company, as Google Contacts matches them: sam, sam@, +44.',
			openIn: 'Google Contacts',
			read: 'readContacts',
			writes: {create: 'writeContacts', update: 'writeContacts'},
			fields: [
				{key: 'name', label: 'Name', type: 'text'},
				{key: 'emails', label: 'Emails', type: 'email'},
				{key: 'phones', label: 'Phone numbers', type: 'text'},
				{key: 'company', label: 'Company', type: 'text'},
				{key: 'jobTitle', label: 'Job title', type: 'text'},
				{key: 'addresses', label: 'Addresses', type: 'longtext'},
				{key: 'birthday', label: 'Birthday', type: 'text'},
				{key: 'notes', label: 'Notes', type: 'longtext'},
			],
		},
	],
};

// A bank login connected through Plaid, in the US and Canada: its accounts and their transactions,
// only ever read. Balances and transactions are each an action of their own, so an agent can be
// told how much there is without seeing what it went on. Balances are as of Plaid's last update
// from the bank, several times a day. Transactions are one tree: the accounts at the top, each
// holding its transactions, newest first, two years of them at most from when the bank was
// connected. Amounts are signed as a statement reads: money out of the account negative, money in
// positive, on a card or a loan too. Plaid has no search in words: a list is narrowed by days.
const plaid: Integration = {
	id: 'plaid',
	name: 'Plaid',
	description: 'Balances and transactions from your bank accounts, cards and loans',
	actions: [
		{
			id: 'readBalances',
			label: 'Read balances',
			description: 'See your accounts and what each holds or owes',
			risk: 'low',
		},
		{
			id: 'readTransactions',
			label: 'Read transactions',
			description: 'List and open each account’s transactions',
			risk: 'medium',
		},
	],
	collections: [
		{
			id: 'accounts',
			name: 'Balances',
			singular: 'account',
			titleField: 'name',
			summaryField: 'balance',
			read: 'readBalances',
			writes: {},
			fields: [
				{key: 'name', label: 'Name', type: 'text', system: true},
				// "Checking", "Credit card", "Mortgage".
				{key: 'type', label: 'Type', type: 'text', system: true},
				// The account number's last digits, as the bank shows them: "••0000".
				{key: 'number', label: 'Number', type: 'text', system: true},
				// What the account holds, or on a card or a loan what is owed: "1234.56 USD".
				{key: 'balance', label: 'Balance', type: 'text', system: true},
				// What can be spent or drawn now, where the bank says.
				{key: 'available', label: 'Available', type: 'text', system: true},
				// A card's or credit line's limit.
				{key: 'limit', label: 'Limit', type: 'text', system: true},
			],
		},
		{
			id: 'transactions',
			name: 'Transactions',
			singular: 'transaction',
			titleField: 'name',
			summaryField: 'amount',
			searchHint:
				'A day, such as 2026-09-30, for the transactions on it and before it, or two, 2026-09-01 2026-09-30, for those between them. At the top, in every account.',
			nested: true,
			read: 'readTransactions',
			writes: {},
			fields: [
				// The merchant where Plaid knows it, else the bank's own description.
				{key: 'name', label: 'Name', type: 'text', system: true},
				{
					key: 'kind',
					label: 'Kind',
					type: 'select',
					options: ['Account', 'Transaction'],
					system: true,
				},
				{key: 'date', label: 'Date', type: 'date', system: true},
				// Money out negative, money in positive: "-12.50 USD".
				{key: 'amount', label: 'Amount', type: 'text', system: true},
				// The account's name and last digits: "Checking ••0000".
				{key: 'account', label: 'Account', type: 'text', system: true},
				// Plaid's category: "Food and drink: Restaurant".
				{key: 'category', label: 'Category', type: 'text', system: true},
				{
					key: 'status',
					label: 'Status',
					type: 'select',
					options: ['Pending', 'Posted'],
					system: true,
				},
				// The bank's own description of it, as the statement shows it.
				{key: 'description', label: 'Description', type: 'text', system: true},
				{key: 'location', label: 'Location', type: 'text', system: true},
			],
		},
	],
};

// Information's actions for one of its collections, such as `readCards` and `writeCards`: reading
// it, and adding, editing and deleting as one.
function infoActions(collectionId: string, plural: string): Action[] {
	const name = collectionId.charAt(0).toUpperCase() + collectionId.slice(1);
	return [
		{
			id: `read${name}`,
			label: `Read ${plural}`,
			description: `List and open ${plural}`,
			risk: 'low',
		},
		{
			id: `write${name}`,
			label: `Edit ${plural}`,
			description: `Add, edit and delete ${plural}`,
			risk: 'medium',
			requires: `read${name}`,
		},
	];
}

function infoAccess(collectionId: string): Pick<Collection, 'read' | 'writes' | 'searchHint'> {
	const name = collectionId.charAt(0).toUpperCase() + collectionId.slice(1);
	const write = `write${name}`;
	return {
		read: `read${name}`,
		writes: {create: write, update: write, delete: write},
		searchHint: 'Matches the words in any field, in any case.',
	};
}

const info: Integration = {
	id: INFO_INTEGRATION_ID,
	name: 'Information',
	description: 'Details you keep in Personal Agent Proxy for agents to use',
	builtIn: true,
	actions: [
		...infoActions('addresses', 'addresses'),
		...infoActions('cards', 'payment cards'),
		...infoActions('notes', 'notes'),
	],
	collections: [
		{
			id: 'addresses',
			name: 'Addresses',
			singular: 'address',
			titleField: 'label',
			summaryField: 'city',
			...infoAccess('addresses'),
			fields: [
				{key: 'label', label: 'Label', type: 'text'},
				{key: 'name', label: 'Name', type: 'text'},
				{key: 'street', label: 'Street', type: 'text'},
				{key: 'postalCode', label: 'Postal code', type: 'text'},
				{key: 'city', label: 'City', type: 'text'},
				{key: 'country', label: 'Country', type: 'text'},
			],
		},
		{
			id: 'cards',
			name: 'Payment cards',
			singular: 'payment card',
			titleField: 'label',
			summaryField: 'number',
			...infoAccess('cards'),
			fields: [
				{key: 'label', label: 'Label', type: 'text'},
				{key: 'cardholder', label: 'Cardholder', type: 'text'},
				{key: 'number', label: 'Number', type: 'secret'},
				{key: 'expiry', label: 'Expiry (MM/YY)', type: 'text'},
			],
		},
		{
			id: 'notes',
			name: 'Notes',
			singular: 'note',
			titleField: 'title',
			...infoAccess('notes'),
			fields: [
				{key: 'title', label: 'Title', type: 'text'},
				{key: 'body', label: 'Body', type: 'longtext'},
			],
		},
	],
};

// Any MCP server, by its address: what it lists as its tools is what an agent can be allowed, one
// by one, so the catalog's entry has no actions of its own. A server that asks for a sign-in gets
// one as Granola's does; one that takes a token typed in, or none, is connected with that. A tool's
// risk is what the tool says of itself: low when it only reads, else high unless it says what it
// changes can be undone.
const mcp: Integration = {
	id: 'mcp',
	name: 'Custom MCP server',
	description: 'Any MCP server, by its address',
	custom: true,
	actions: [],
	collections: [],
};

export const INTEGRATIONS: Integration[] = [
	info,
	email,
	google,
	granola,
	notion,
	linear,
	plaid,
	postgres,
	mysql,
	mcp,
];

export function findIntegration(id: string): Integration | undefined {
	return INTEGRATIONS.find((integration) => integration.id === id);
}

export function findCollection<T extends {collections: Collection[]}>(
	integration: T,
	id: string,
): Collection | undefined {
	return integration.collections.find((collection) => collection.id === id);
}
