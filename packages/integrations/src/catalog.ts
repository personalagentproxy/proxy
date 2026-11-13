import {type Experiment, hasExperiment} from '@proxy/utils';

import type {Collection, Condition, Integration} from './types';

const INBOX: Condition = {field: 'folder', values: ['Inbox']};

export const VAULT_INTEGRATION_ID = 'vault';

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
			// Who else it goes to, comma-separated as to is: read when the email is opened, never in a list.
			{key: 'cc', label: 'Cc', type: 'email'},
			// Who it goes to unseen, which only the account's own drafts and sent email show.
			{key: 'bcc', label: 'Bcc', type: 'email'},
			{key: 'subject', label: 'Subject', type: 'text'},
			{key: 'date', label: 'Date', type: 'datetime', system: true},
			// "Unread, Flagged" ("Unread, Starred" on Gmail), for an email in the inbox.
			{key: 'status', label: 'Status', type: 'text', system: true},
			{key: 'body', label: 'Body', type: 'longtext'},
			// One a line, numbered as the attachments collection reads them by: "1. Q3.xlsx
			// (application/…, 48 KB)".
			{key: 'attachments', label: 'Attachments', type: 'longtext', system: true},
			// Its own header, "<q3@example.com>", which a reply to it names as the email it answers.
			{key: 'messageId', label: 'Message-ID', type: 'text', system: true},
			// Gmail's id of the conversation it is in, which a reply to it joins; other mailboxes have none.
			{key: 'thread', label: 'Thread', type: 'text', system: true},
			// The labels of the account's own on it, comma-separated, when it is opened: Clients/Acme,
			// Follow up. Gmail's own, as its folder and status say, are left out; other mailboxes have none.
			{key: 'labels', label: 'Labels', type: 'text', system: true},
		],
	};
}

/**
 * Replies to email, each written in the thread of the email it answers: never listed or opened,
 * only sent at once, with the action sending email and the one reading it, or saved as a draft,
 * with the one writing drafts. Who it goes to, its subject and its thread come from the email.
 */
function repliesCollection(actions: Pick<EmailActions, 'read' | 'write' | 'send'>): Collection {
	const what =
		'Name the email by its id, as a list gives it, and write the reply as body: whom it goes to, its subject and its thread come from the email, as a mail app’s Reply writes them. With replyAll Yes it also goes to everyone else the email went to. Answers whom it went to, its subject and its id among email, with its thread on Gmail.';
	return {
		id: 'replies',
		name: 'Replies',
		singular: 'reply',
		titleField: 'subject',
		writes: {},
		commands: [
			{
				id: 'send',
				on: 'new',
				label: 'Send',
				description: `Reply to an email in its thread, and send the reply at once. ${what}`,
				action: actions.send,
				requires: actions.read,
				done: 'Sent {}',
				tried: 'send {}',
			},
			{
				id: 'draft',
				on: 'new',
				label: 'Save as draft',
				description: `Reply to an email in its thread, saved as a draft for emails_send to send later. ${what}`,
				action: actions.write,
				done: 'Saved {} as a draft',
				tried: 'save {} as a draft',
			},
		],
		fields: [
			{key: 'email', label: 'Email', type: 'text'},
			{key: 'body', label: 'Body', type: 'longtext'},
			{key: 'replyAll', label: 'Reply all', type: 'select', options: ['Yes', 'No']},
			{key: 'to', label: 'To', type: 'email', system: true},
			{key: 'cc', label: 'Cc', type: 'email', system: true},
			{key: 'subject', label: 'Subject', type: 'text', system: true},
			// Gmail's, as the email's.
			{key: 'thread', label: 'Thread', type: 'text', system: true},
		],
	};
}

/**
 * An email's attachments, read as text with the action reading the email: never listed or opened,
 * only read, one at a time, by the email's id and the attachment's number among those the email
 * lists, or its name.
 */
function attachmentsCollection(read: string): Collection {
	return {
		id: 'attachments',
		name: 'Attachments',
		singular: 'attachment',
		titleField: 'name',
		writes: {},
		commands: [
			{
				id: 'read',
				on: 'new',
				label: 'Read',
				description:
					'Read one of an email’s attachments as text: a spreadsheet’s tabs as CSV, a PDF’s or a Word document’s text, a forwarded email, or text as it is. Name the email by its id, as a list gives it, and the attachment by its number among the attachments the email lists, or its name. Images and other files are turned down.',
				action: read,
				readOnly: true,
				done: 'Read {}',
				tried: 'read {}',
			},
		],
		fields: [
			{key: 'email', label: 'Email', type: 'text'},
			{key: 'attachment', label: 'Attachment', type: 'text'},
			{key: 'name', label: 'Name', type: 'text', system: true},
			{key: 'type', label: 'Type', type: 'text', system: true},
			{key: 'size', label: 'Size', type: 'text', system: true},
			// "1234 characters", or how many of more were answered: at most 100,000.
			{key: 'length', label: 'Length', type: 'text', system: true},
			{key: 'content', label: 'Content', type: 'longtext', system: true},
		],
	};
}

// Any mailbox over IMAP and SMTP, signed in with an app password. The password can't be limited,
// so access is only ever narrowed in Personal Agent Proxy. The inbox, drafts and sent mail are one
// list, each email saying which folder it is in. Received emails are never edited or deleted for
// good: they are marked, flagged, archived or moved to Trash. Sending needs nothing else, so an
// agent can send without reading the mailbox; sending a reply, which reads the email it answers,
// needs Read too.
const email: Integration = {
	id: 'email',
	name: 'Email',
	description: 'Gmail, iCloud, Fastmail or any IMAP mailbox',
	form: 'email',
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
			description: 'Create, edit and delete drafts, replies in an email’s thread among them',
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
			description:
				'Send email from this address: new, from a draft, or a reply, which needs Read too',
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
		attachmentsCollection('read'),
		repliesCollection({read: 'read', write: 'write', send: 'send'}),
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
	signIn: true,
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
	signIn: true,
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
	signIn: true,
	apiKey: {keysUrl: 'https://linear.app/settings/account/security'},
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

// The methods a Cloudflare API request is sent with, each needing the action of what it does.
const CLOUDFLARE_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

// A Cloudflare account, through Cloudflare's MCP server, which reaches all of Cloudflare's API:
// zones and their DNS records, Workers, KV, R2, D1, Pages, analytics and the rest, as the person who
// signed in, or as the API token given. A sign-in is narrowed on Cloudflare's own page, a token by
// its permissions; Personal Agent Proxy narrows it again by what a request does, by its method:
// reading, creating and changing, and deleting are each an action of their own. A GraphQL
// analytics query is a read. An agent finds the endpoint in Cloudflare's API reference or its docs,
// then sends the request. Requests are only ever run, never listed or kept: nothing is copied.
const cloudflare: Integration = {
	id: 'cloudflare',
	signIn: true,
	apiKey: {keysUrl: 'https://dash.cloudflare.com/profile/api-tokens'},
	name: 'Cloudflare',
	description: 'Zones, DNS, Workers and the rest of an account',
	actions: [
		{
			id: 'read',
			label: 'Read',
			description:
				'Look up endpoints in Cloudflare’s API reference and docs, and send GET requests and GraphQL analytics queries, such as listing zones, DNS records or Workers',
			risk: 'low',
		},
		{
			id: 'write',
			label: 'Create and change',
			description:
				'Send POST, PUT and PATCH requests, such as adding a DNS record, deploying a Worker, running a D1 query or changing a setting, which apply to live sites at once. Cloudflare still allows only what the sign-in or API token was granted: a request beyond it is turned down, naming the permission it needs',
			risk: 'high',
			requires: 'read',
		},
		{
			id: 'delete',
			label: 'Delete',
			description:
				'Send DELETE requests, such as removing a DNS record, a Worker or a bucket, for good. Cloudflare still allows only what the sign-in or API token was granted: a request beyond it is turned down, naming the permission it needs',
			risk: 'high',
			requires: 'read',
		},
	],
	collections: [
		{
			id: 'requests',
			name: 'API requests',
			singular: 'request',
			titleField: 'path',
			summaryField: 'method',
			writes: {},
			commands: [
				{
					id: 'read',
					on: 'new',
					label: 'Read',
					action: 'read',
					readOnly: true,
					done: 'Read {}',
					tried: 'read {}',
				},
				{
					id: 'send',
					on: 'new',
					label: 'Send',
					action: 'write',
					done: 'Sent {}',
					tried: 'send {}',
				},
				{
					id: 'remove',
					on: 'new',
					label: 'Delete',
					action: 'delete',
					done: 'Deleted {}',
					tried: 'delete {}',
				},
			],
			fields: [
				// Left out, the one the command sends: GET to read, POST to send, DELETE to delete.
				{key: 'method', label: 'Method', type: 'select', options: CLOUDFLARE_METHODS},
				// As Cloudflare's API reference writes it, with its query: "/zones?name=example.com", or
				// "/graphql" for an analytics query. `{account_id}` stands for the account.
				{key: 'path', label: 'Path', type: 'text'},
				// JSON: {"type": "A", "name": "www", "content": "192.0.2.1"}, or {"query": "…"} for GraphQL.
				{key: 'body', label: 'Body', type: 'longtext'},
				// The account `{account_id}` is, where the sign-in or token has more than one.
				{key: 'account', label: 'Account ID', type: 'text'},
				// Cloudflare's answer as JSON, whole, or where it runs long its start and a line saying it was cut.
				{key: 'response', label: 'Response', type: 'longtext', system: true},
			],
		},
		{
			id: 'endpoints',
			name: 'API reference',
			singular: 'endpoint',
			titleField: 'search',
			writes: {},
			commands: [
				{
					id: 'find',
					on: 'new',
					label: 'Find',
					action: 'read',
					readOnly: true,
					done: 'Looked up {}',
					tried: 'look up {}',
				},
			],
			fields: [
				// Words in an endpoint's path, summary or product, "dns records", for a list of them; or one
				// endpoint, "POST /zones/{zone_id}/dns_records", for its parameters and body.
				{key: 'search', label: 'Search', type: 'text'},
				// One endpoint a line, "GET /zones/{zone_id}/dns_records List DNS Records"; or one's details as JSON.
				{key: 'endpoints', label: 'Endpoints', type: 'longtext', system: true},
			],
		},
		{
			id: 'docs',
			name: 'Docs',
			singular: 'docs search',
			titleField: 'query',
			writes: {},
			commands: [
				{
					id: 'run',
					on: 'new',
					label: 'Run',
					action: 'read',
					readOnly: true,
					done: 'Searched the docs for {}',
					tried: 'search the docs for {}',
				},
			],
			fields: [
				{key: 'query', label: 'Query', type: 'text'},
				// The passages of developers.cloudflare.com that fit, each with its page's title and address.
				{key: 'results', label: 'Results', type: 'longtext', system: true},
			],
		},
	],
};

// The web, searched and read through a search engine made for agents, through its MCP server after
// signing in to it or with an API key made at `keysUrl`: what an agent searches for and the pages
// it reads go to the provider, on the account signed in with or the key's. A search is answered as
// the provider's results, each page's title, address and the passages that fit the query; a page as
// its text. Nothing is listed or kept: searches and pages are only ever run.
function webIntegration(
	id: 'exa' | 'parallel',
	name: string,
	description: string,
	keysUrl: string,
): Integration {
	return {
		id,
		name,
		description,
		signIn: true,
		apiKey: {keysUrl},
		anonymous: true,
		actions: [
			{
				id: 'search',
				label: 'Search the web',
				description:
					'Search the web, describing what to find in plain words, for pages with the passages that fit',
				risk: 'low',
			},
			{
				id: 'fetch',
				label: 'Read web pages',
				description: 'Read a web page’s text by its address',
				risk: 'low',
			},
		],
		collections: [
			{
				id: 'searches',
				name: 'Searches',
				singular: 'search',
				titleField: 'query',
				writes: {},
				commands: [
					{
						id: 'run',
						on: 'new',
						label: 'Run',
						action: 'search',
						readOnly: true,
						done: 'Ran {}',
						tried: 'run {}',
					},
				],
				fields: [
					// What to find, described in plain words: "blog posts comparing React and Vue performance".
					{key: 'query', label: 'Query', type: 'text'},
					// One page a block, "Title: …", "URL: …", "Published: …" and its passages, the blocks
					// between "---" lines.
					{key: 'results', label: 'Results', type: 'longtext', system: true},
				],
			},
			{
				id: 'pages',
				name: 'Pages',
				singular: 'page',
				titleField: 'url',
				summaryField: 'title',
				writes: {},
				commands: [
					{
						id: 'read',
						on: 'new',
						label: 'Read',
						action: 'fetch',
						readOnly: true,
						done: 'Read {}',
						tried: 'read {}',
					},
				],
				fields: [
					{key: 'url', label: 'URL', type: 'text'},
					{key: 'title', label: 'Title', type: 'text', system: true},
					// As Markdown, where the provider gives it so; where it runs long, its start and a line
					// saying it was cut.
					{key: 'content', label: 'Content', type: 'longtext', system: true},
				],
			},
		],
	};
}

const exa = webIntegration(
	'exa',
	'Exa',
	'Search and read the web',
	'https://dashboard.exa.ai/api-keys',
);

const parallel = webIntegration(
	'parallel',
	'Parallel',
	'Search and read the web',
	'https://platform.parallel.ai',
);

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
		form: 'database',
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
// Gmail, Calendar, Drive, Docs, Sheets, Slides, Contacts and Tasks. One connection holds every product, so
// action ids carry the product, such as `readEmails` and `sendEmails`, and each action
// names its product as its group. Gmail is the same email as any mailbox's, its labels as folders:
// all mail but Spam and Trash in one list, narrowed to the inbox, drafts, sent mail, the archive,
// Trash or Spam; the labels the account made are put on email and taken off on their own. Drafts
// are the only email edited or deleted; nothing else is deleted for good, only moved to Trash. Calendar is one tree of the calendars and their events. Drive is one tree: My
// Drive, Shared with me, Shared drives and Recent at the top, folders holding files, a spreadsheet
// holding its tabs and a tab its rows. Documents read as Markdown, presentations as text, rows as
// "Header: value" lines; new documents are written as Markdown and new spreadsheets as CSV, which
// Drive converts, and a spreadsheet's ranges are read and written in A1 notation as CSV. Files are
// moved to Trash, never deleted, and neither are events, contacts or tasks. Who is free is asked
// of Google for the people named, and the people Gmail keeps under Other contacts are only read.
// Tasks are one tree: the task lists at the top, each holding its tasks. Nothing is copied: every
// request goes to Google.
const google: Integration = {
	id: 'google',
	signIn: true,
	name: 'Google',
	description:
		'Gmail, Calendar, Drive, Docs, Sheets, Slides, Contacts and Tasks for one Google account',
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
			id: 'labelEmails',
			label: 'Label',
			description:
				'Put your own labels on emails and take them off, making a label where none has the name',
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
			description: 'Create, edit and delete drafts, replies in an email’s thread among them',
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
			description:
				'Send email from this address: new, from a draft, or a reply, which needs Read email too',
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
			id: 'readAvailability',
			label: 'See when people are free',
			description: 'See when you and the people you name are busy, without what they are doing',
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
			id: 'readOtherContacts',
			label: 'Read other contacts',
			description: 'List and search the people you emailed, whom Gmail keeps under Other contacts',
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
		{
			id: 'readTasks',
			label: 'Read tasks',
			description: 'See your task lists and the tasks in them',
			risk: 'low',
			group: 'Tasks',
		},
		{
			id: 'writeTasks',
			label: 'Add and edit tasks',
			description: 'Add tasks, change them, move them to another list, and complete or reopen them',
			risk: 'medium',
			requires: 'readTasks',
			group: 'Tasks',
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
		attachmentsCollection('readEmails'),
		repliesCollection({read: 'readEmails', write: 'writeEmails', send: 'sendEmails'}),
		// The labels the account made, by name, all on one page: listed and opened with Read email,
		// put on an email and taken off with Label. Gmail's own, Inbox, Starred, Unread, Spam, Trash
		// and the categories, are left out: the email's own commands change those.
		{
			id: 'labels',
			name: 'Labels',
			singular: 'label',
			titleField: 'label',
			searchHint: 'Words in a label’s name.',
			openIn: 'Gmail',
			read: 'readEmails',
			writes: {},
			commands: [
				{
					id: 'add',
					on: 'new',
					label: 'Add label',
					description:
						'Put one of your own labels on an email. Name the email by its id, as a list gives it, and the label by its name, as labels_list gives it, a nested one with slashes: Clients/Acme. Where the account has no label of the name, it is made, and made answers Yes. Gmail’s own labels, such as Inbox, Starred or Unread, aren’t put on here, and drafts aren’t labelled.',
					action: 'labelEmails',
					done: 'Put {} on an email',
					tried: 'put {} on an email',
				},
				{
					id: 'remove',
					on: 'new',
					label: 'Remove label',
					description:
						'Take one of your own labels off an email, which leaves the label and the email where they are. Name the email by its id, as a list gives it, and the label by its name, as labels_list gives it.',
					action: 'labelEmails',
					done: 'Took {} off an email',
					tried: 'take {} off an email',
				},
			],
			fields: [
				// Its name, as Gmail shows it, a nested label's with slashes: Clients/Acme.
				{key: 'label', label: 'Label', type: 'text'},
				// The email Add label and Remove label work on, by its id.
				{key: 'email', label: 'Email', type: 'text'},
				// How many emails it is on, and how many of them are unread, when a label is opened.
				{key: 'messages', label: 'Emails', type: 'text', system: true},
				{key: 'unread', label: 'Unread', type: 'text', system: true},
				// Whether Add label made the label, the account having none of the name.
				{key: 'made', label: 'Made', type: 'select', options: ['Yes', 'No'], system: true},
			],
		},
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
		// When the account and the people named are busy, as Google's free/busy says, without what
		// they are doing, and the times all of them are free. Never listed or opened, only checked. A
		// time is written as an event's is, on the primary calendar's clock or with an offset, and a
		// day alone is the whole day; times are answered on the primary calendar's clock.
		{
			id: 'availability',
			name: 'Availability',
			singular: 'availability',
			titleField: 'people',
			writes: {},
			commands: [
				{
					id: 'check',
					on: 'new',
					label: 'Check',
					action: 'readAvailability',
					readOnly: true,
					done: 'Checked {}',
					tried: 'check {}',
				},
			],
			fields: [
				// Whom to check beside the account itself, which is always checked, by their addresses.
				{key: 'people', label: 'People', type: 'email'},
				// From now where left out.
				{key: 'from', label: 'From', type: 'text'},
				// A week after From where left out.
				{key: 'to', label: 'To', type: 'text'},
				// The primary calendar's time zone, which the busy and free times are on.
				{key: 'timeZone', label: 'Time zone', type: 'text', system: true},
				// Each person's busy times, one person a line, or that their calendar can't be seen.
				{key: 'busy', label: 'Busy', type: 'longtext', system: true},
				// The times everyone whose calendar could be seen is free, one a line, nights included.
				{key: 'free', label: 'Free', type: 'longtext', system: true},
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
		// The people Gmail keeps under Other contacts: those the account emailed or was emailed by but
		// never saved, by their names, addresses and numbers, only read. Saving one makes a contact of
		// it in Google Contacts, which needs Add and edit contacts.
		{
			id: 'otherContacts',
			name: 'Other contacts',
			singular: 'other contact',
			titleField: 'name',
			summaryField: 'emails',
			searchHint:
				'The start of a name, email address or phone number, as Google Contacts matches them: sam, sam@, +44.',
			read: 'readOtherContacts',
			writes: {},
			commands: [
				{
					id: 'save',
					on: 'record',
					label: 'Save to contacts',
					action: 'writeContacts',
					done: 'Saved {} to contacts',
					tried: 'save {} to contacts',
				},
			],
			fields: [
				{key: 'name', label: 'Name', type: 'text', system: true},
				{key: 'emails', label: 'Emails', type: 'email', system: true},
				{key: 'phones', label: 'Phone numbers', type: 'text', system: true},
			],
		},
		// The account's task lists in Google Tasks, each holding its tasks in Google's own order,
		// subtasks among them. A due date is a day alone, 2026-10-15, as Google Tasks keeps it. A task
		// is completed or reopened, and moved to another list by writing that list's name; tasks and
		// lists are never deleted here.
		{
			id: 'tasks',
			name: 'Tasks',
			singular: 'task',
			titleField: 'title',
			summaryField: 'due',
			filterField: 'status',
			nested: true,
			openIn: 'Google Tasks',
			read: 'readTasks',
			writes: {create: 'writeTasks', update: 'writeTasks'},
			// Lists are only read.
			editable: {field: 'kind', values: ['Task']},
			commands: [
				{
					id: 'complete',
					on: 'record',
					label: 'Complete',
					action: 'writeTasks',
					where: {field: 'status', values: ['Needs action']},
					done: 'Completed {}',
					tried: 'complete {}',
				},
				{
					id: 'reopen',
					on: 'record',
					label: 'Reopen',
					action: 'writeTasks',
					where: {field: 'status', values: ['Done']},
					done: 'Reopened {}',
					tried: 'reopen {}',
				},
			],
			fields: [
				{key: 'title', label: 'Title', type: 'text'},
				{key: 'kind', label: 'Kind', type: 'select', options: ['List', 'Task'], system: true},
				{key: 'notes', label: 'Notes', type: 'longtext'},
				{key: 'due', label: 'Due', type: 'date'},
				// The list a task is in; writing another list's name moves the task there.
				{key: 'list', label: 'List', type: 'text'},
				{
					key: 'status',
					label: 'Status',
					type: 'select',
					options: ['Needs action', 'Done'],
					system: true,
				},
				{key: 'completed', label: 'Completed', type: 'datetime', system: true},
				// The title of the task a subtask is under.
				{key: 'subtaskOf', label: 'Subtask of', type: 'text', system: true},
				// What a task was made from, such as an email in Gmail, by its link.
				{key: 'source', label: 'Made from', type: 'text', system: true},
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
	form: 'bank',
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
			listsAll: true,
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
			listsAll: true,
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

// What a vault entry's value is, so a row shows it as such and an agent knows what it holds.
export const VAULT_ENTRY_TYPES = ['Text', 'Address', 'Phone number', 'Email', 'Link', 'Date'];

// The vault: what a person keeps in Personal Agent Proxy for their agents, and what agents keep
// there for them, as a memory. Each entry is a title, a type and its content, all plain text to an
// agent allowed to read it.
const vault: Integration = {
	id: VAULT_INTEGRATION_ID,
	name: 'Vault',
	description: 'What agents should know, kept in Personal Agent Proxy',
	native: true,
	made: {one: 'vault', holds: 'entries'},
	actions: [
		{id: 'readEntries', label: 'Read entries', description: 'List and open entries', risk: 'low'},
		{
			id: 'writeEntries',
			label: 'Edit entries',
			description: 'Add, edit and delete entries',
			risk: 'medium',
			requires: 'readEntries',
		},
	],
	collections: [
		{
			id: 'entries',
			name: 'Entries',
			singular: 'entry',
			titleField: 'title',
			summaryField: 'content',
			read: 'readEntries',
			writes: {create: 'writeEntries', update: 'writeEntries', delete: 'writeEntries'},
			searchHint: 'Matches the words in the title, the type or the content, in any case.',
			fields: [
				{key: 'title', label: 'Title', type: 'text'},
				{key: 'type', label: 'Type', type: 'select', options: VAULT_ENTRY_TYPES},
				{key: 'content', label: 'Content', type: 'longtext'},
			],
		},
	],
};

// What agents may do with a vault by default, a member's own and any they make: read it, and
// keep what they learn there, unless told otherwise.
export const VAULT_DEFAULT_ACTIONS: string[] = vault.actions.map((action) => action.id);

export const SANDBOX_INTEGRATION_ID = 'sandbox';

/** The longest a command may run in a sandbox, and how long one runs unless told otherwise. */
export const SANDBOX_EXEC_MAX_SECONDS = 120;
export const SANDBOX_EXEC_DEFAULT_SECONDS = 60;

// Sandboxes live in Personal Agent Proxy itself, as the vault does: computers an agent asks for
// and works on, each kept while it is away, asleep, and woken by its next command. Every
// member has a Sandboxes connection, as they have a vault; what an agent may
// do there is set per action, as on any connection. The sandboxes are the collection, listed
// and made as records; the console is the one tool of the integration's own, since reading and
// writing files is done through it. Offered where the organization has the experiment and the
// server a sandbox backend (SANDBOX_SERVICE_URL).
const sandbox: Integration = {
	id: SANDBOX_INTEGRATION_ID,
	name: 'Sandboxes',
	description: 'Computers of their own for your agents to work on, kept while they are away',
	native: true,
	experiment: 'sandboxes',
	actions: [
		{
			id: 'read',
			label: 'See sandboxes',
			description: 'List the sandboxes and open one',
			risk: 'low',
		},
		{
			id: 'run',
			label: 'Use sandboxes',
			description:
				'Make sandboxes, wake them and run commands in them, which can do anything a computer with the internet can',
			risk: 'high',
			requires: 'read',
		},
		{
			id: 'delete',
			label: 'Delete sandboxes',
			description: 'Delete a sandbox and everything in it, for good',
			risk: 'high',
			requires: 'read',
		},
	],
	collections: [
		{
			id: 'sandboxes',
			name: 'Sandboxes',
			singular: 'sandbox',
			titleField: 'name',
			summaryField: 'state',
			read: 'read',
			writes: {create: 'run', delete: 'delete'},
			fields: [
				{key: 'name', label: 'Name', type: 'text'},
				{
					key: 'state',
					label: 'State',
					type: 'select',
					options: ['Running', 'Asleep'],
					system: true,
				},
				{key: 'heldBy', label: 'In use by', type: 'text', system: true},
				{key: 'lastUsedAt', label: 'Last used', type: 'datetime', system: true},
			],
			commands: [
				{
					id: 'sleep',
					on: 'record',
					label: 'Put to sleep',
					description:
						'Puts a sandbox to sleep, keeping everything on its disk; its next command wakes it. Whatever a command left running is gone.',
					action: 'run',
					where: {field: 'state', values: ['Running']},
					done: 'Put {} to sleep',
					tried: 'put {} to sleep',
				},
				{
					id: 'wake',
					on: 'record',
					label: 'Wake',
					description: 'Wakes a sandbox that is asleep, with its disk as it was.',
					action: 'run',
					where: {field: 'state', values: ['Asleep']},
					done: 'Woke {}',
					tried: 'wake {}',
				},
			],
		},
	],
	tools: [
		{
			name: 'sandbox_exec',
			title: 'Run command',
			description: `Runs a command in a sandbox’s shell, in its home or in cwd under it, and answers with what it wrote and how it ended. A sandbox asleep is woken first. Reading and writing files is done here too: cat a file to read it; to write one, give the content as stdin and run cat > the file. The command is stopped after timeout seconds, ${SANDBOX_EXEC_DEFAULT_SECONDS} unless given and at most ${SANDBOX_EXEC_MAX_SECONDS}; what it left running in the background may not outlive it, so do long work in parts. With pap, the command can run pap, a CLI for your connections (pap --help).`,
			action: 'run',
			inputSchema: {
				type: 'object',
				properties: {
					sandbox: {
						type: 'string',
						description: 'The sandbox’s id, from sandboxes_list or sandboxes_create',
					},
					command: {type: 'string', description: 'The command, for sh'},
					stdin: {
						type: 'string',
						description: 'What the command reads on stdin, such as the content of a file to write',
					},
					cwd: {
						type: 'string',
						description: 'The directory to run in, under the sandbox’s home; the home unless given',
					},
					timeout: {
						type: 'number',
						description: `Seconds before the command is stopped: ${SANDBOX_EXEC_DEFAULT_SECONDS} unless given, at most ${SANDBOX_EXEC_MAX_SECONDS}`,
					},
					pap: {
						type: 'boolean',
						description: 'Lets the command use pap, to call your connections from code',
					},
				},
				required: ['sandbox', 'command'],
			},
		},
	],
};

export const FILES_INTEGRATION_ID = 'files';

/** How much of a file's text a read answers at once, and where the next read goes on from. */
export const FILES_READ_CHARACTERS = 50_000;

/** How long what is put in the trash stays there before it is deleted for good. */
export const FILES_TRASH_DAYS = 30;

// Files live in Personal Agent Proxy itself, as the vault does: a drive of folders and files for
// each member, what the person hands their agents and what agents make for them, and the drives
// members make beside their own, each named, for a team or a project, shared as any connection. A file's content
// is never changed in place: every write is its next version, and those before stay, so whatever
// an agent wrote over can be given back. The collection lists folders and opens files, as text
// where they can be read as it; the writes are tools of the integration's own, since each names
// who made the change and, to write over a file, the version that was read. A tool carries text:
// the bytes of a file that isn't text go up and come down in the web app. Offered where the organization has the
// experiment and the server a place for the bytes (FILES_DIR or FILES_S3_BUCKET).
const files: Integration = {
	id: FILES_INTEGRATION_ID,
	name: 'Files',
	description: 'Files and folders kept in Personal Agent Proxy, with every version of each',
	native: true,
	made: {one: 'drive', holds: 'files'},
	experiment: 'files',
	actions: [
		{
			id: 'readFiles',
			label: 'Read files',
			description: 'List folders, open files and see their earlier versions',
			risk: 'low',
		},
		{
			id: 'createFiles',
			label: 'Add files',
			description: 'Add files and folders, never over one that is there',
			risk: 'low',
			requires: 'readFiles',
		},
		{
			id: 'editFiles',
			label: 'Edit files',
			description:
				'Write over a file, rename it, move it, and give an earlier version back; every version before is kept',
			risk: 'medium',
			requires: 'readFiles',
		},
		{
			id: 'trashFiles',
			label: 'Move to trash',
			description: `Move files and folders to the trash and take them out again; the trash is emptied after ${FILES_TRASH_DAYS} days`,
			risk: 'medium',
			requires: 'readFiles',
		},
	],
	collections: [
		{
			id: 'files',
			name: 'Files',
			singular: 'file',
			titleField: 'name',
			summaryField: 'kind',
			searchHint:
				'Words in a file’s or a folder’s name, in any case, anywhere in the drive, or inside the folder opened.',
			nested: true,
			read: 'readFiles',
			writes: {},
			// The fields every integration's files have, which the home page's widgets read
			// (catalog.test.ts). What a write needs beside them, the version a file holds, is what
			// files_read answers with.
			fields: [
				{key: 'name', label: 'Name', type: 'text', system: true},
				{key: 'kind', label: 'Kind', type: 'select', options: ['Folder', 'File'], system: true},
				{key: 'modified', label: 'Modified', type: 'datetime', system: true},
				// Whose drive it is in.
				{key: 'owner', label: 'Owner', type: 'text', system: true},
				// A file's text, where it can be read as text: text as it is, a spreadsheet's tabs as CSV,
				// a PDF's or a Word document's text; the first of it for a long one, and for one that
				// isn't text, what it is.
				{key: 'content', label: 'Content', type: 'longtext', system: true},
			],
		},
	],
	tools: [
		{
			name: 'files_create',
			title: 'Add file',
			description:
				'Adds a file holding content as text, or a folder, called name, in the folder parent or at the top. Refused where something there has the name: files_write changes a file that is there.',
			action: 'createFiles',
			inputSchema: {
				type: 'object',
				properties: {
					name: {type: 'string', description: 'Its name, with its extension, as notes.md'},
					parent: {
						type: 'string',
						description: 'The id of the folder to put it in; left out, the top',
					},
					content: {
						type: 'string',
						description: 'A file’s content, as text; left out, an empty file',
					},
					folder: {type: 'boolean', description: 'Makes a folder instead of a file'},
				},
				required: ['name'],
			},
		},
		{
			name: 'files_write',
			title: 'Write file',
			description:
				'Writes content, as text, over what a file holds, as its next version; the one before is kept (files_versions). Give the version files_read answered with: where the file changed since, the write is refused, and you read it again.',
			action: 'editFiles',
			inputSchema: {
				type: 'object',
				properties: {
					id: {type: 'string', description: 'The file’s id'},
					version: {type: 'string', description: 'The version you read'},
					content: {type: 'string', description: 'All of its new content, as text'},
				},
				required: ['id', 'version', 'content'],
			},
		},
		{
			name: 'files_read',
			title: 'Read file',
			description: `Reads a file’s text, ${FILES_READ_CHARACTERS} characters at a time: what it holds now, or an earlier version. Answers with the version read.`,
			action: 'readFiles',
			readOnly: true,
			inputSchema: {
				type: 'object',
				properties: {
					id: {type: 'string', description: 'The file’s id'},
					version: {
						type: 'string',
						description: 'An earlier version, from files_versions; left out, what it holds now',
					},
					from: {
						type: 'number',
						description: 'The character to read on from, as the read before said',
					},
				},
				required: ['id'],
			},
		},
		{
			name: 'files_versions',
			title: 'List versions',
			description:
				'Lists a file’s versions, newest first: each one’s id, when it was made, its size and who made it.',
			action: 'readFiles',
			readOnly: true,
			inputSchema: {
				type: 'object',
				properties: {id: {type: 'string', description: 'The file’s id'}},
				required: ['id'],
			},
		},
		{
			name: 'files_restore',
			title: 'Restore version',
			description:
				'Gives a file an earlier version back, as its next version: nothing of its history is lost, and what it held until now is in it too.',
			action: 'editFiles',
			inputSchema: {
				type: 'object',
				properties: {
					id: {type: 'string', description: 'The file’s id'},
					version: {type: 'string', description: 'The version to give back, from files_versions'},
				},
				required: ['id', 'version'],
			},
		},
		{
			name: 'files_move',
			title: 'Rename or move',
			description: 'Renames a file or a folder, moves it into another folder, or both.',
			action: 'editFiles',
			inputSchema: {
				type: 'object',
				properties: {
					id: {type: 'string', description: 'The file’s or the folder’s id'},
					name: {type: 'string', description: 'Its new name; left out, it keeps its own'},
					parent: {
						type: 'string',
						description:
							'The id of the folder to move it into, or top for the top of the drive; left out, it stays',
					},
				},
				required: ['id'],
			},
		},
		{
			name: 'files_trash',
			title: 'Move to trash',
			description: `Moves a file, or a folder with everything in it, to the trash, where it stays ${FILES_TRASH_DAYS} days; files_untrash takes it out.`,
			action: 'trashFiles',
			inputSchema: {
				type: 'object',
				properties: {id: {type: 'string', description: 'The file’s or the folder’s id'}},
				required: ['id'],
			},
		},
		{
			name: 'files_untrash',
			title: 'Take out of trash',
			description: 'Takes a file or a folder out of the trash, back where it was.',
			action: 'trashFiles',
			inputSchema: {
				type: 'object',
				properties: {id: {type: 'string', description: 'The file’s or the folder’s id'}},
				required: ['id'],
			},
		},
	],
};

/** What agents may do with a drive by default, a member's own and any they make: everything, since nothing done there is lost. */
export const FILES_DEFAULT_ACTIONS: string[] = files.actions.map((action) => action.id);

// GitHub, signed in to through Personal Agent Proxy's GitHub App as the person: the repositories
// the app is installed on that they can reach, read live from GitHub, and worked in from a sandbox
// with `pap git` and `pap gh`, whose requests the api relays to GitHub with the connection's token
// (api/src/cli/github), checking each against these actions (api/src/cli/github/needs.ts). What
// the app may do on them is set at GitHub, when it is installed; what an agent may do with the
// connection is set here. Everything but Read starts off: a new connection's defaults are Read
// alone (api/src/connections/github/route.ts), and an older one's stored defaults never had more.
const github: Integration = {
	id: 'github',
	signIn: true,
	name: 'GitHub',
	description: 'Repositories on GitHub, those the app is installed on',
	sharingWarning:
		'Whoever’s agents use it, what they push, open and comment on GitHub shows as this account’s.',
	actions: [
		{
			id: 'read',
			label: 'Read repositories',
			description:
				'List the repositories the app is installed on and open one; from a sandbox, clone and fetch them, and read through GitHub’s API',
			risk: 'low',
		},
		{
			id: 'push',
			label: 'Push to branches',
			description:
				'From a sandbox, push to any branch but the default one, and push tags, with git (pap git) or GitHub’s API',
			risk: 'high',
			requires: 'read',
			reachesOthers: true,
		},
		{
			id: 'pushDefault',
			label: 'Push to the default branch',
			description:
				'Push to the repository’s default branch, such as main, without a pull request: commit to it, reset it or delete it',
			risk: 'high',
			requires: 'push',
			reachesOthers: true,
		},
		{
			id: 'contribute',
			label: 'Open pull requests and issues',
			description:
				'From a sandbox with the GitHub CLI (pap gh): open, edit, close and review pull requests, open and edit issues, comment, label and assign',
			risk: 'high',
			requires: 'read',
			reachesOthers: true,
		},
		{
			id: 'merge',
			label: 'Merge pull requests',
			description:
				'Merge pull requests, or have them merged once their checks pass, from a sandbox with the GitHub CLI (pap gh)',
			risk: 'high',
			requires: 'read',
			reachesOthers: true,
		},
		{
			id: 'manage',
			label: 'Change anything else on GitHub',
			description:
				'Anything else GitHub’s API changes, from a sandbox: repository settings, releases, workflow runs, forks, labels, webhooks, and more',
			risk: 'high',
			requires: 'read',
			reachesOthers: true,
		},
	],
	collections: [
		{
			id: 'repositories',
			name: 'Repositories',
			singular: 'repository',
			titleField: 'fullName',
			summaryField: 'description',
			openIn: 'GitHub',
			read: 'read',
			writes: {},
			fields: [
				// "owner/name", as GitHub writes it, which is the repository's id here.
				{key: 'fullName', label: 'Repository', type: 'text'},
				{key: 'description', label: 'Description', type: 'text'},
				{
					key: 'visibility',
					label: 'Visibility',
					type: 'select',
					options: ['Public', 'Private'],
					system: true,
				},
				{key: 'defaultBranch', label: 'Default branch', type: 'text', system: true},
				{key: 'language', label: 'Language', type: 'text', system: true},
				{key: 'pushed', label: 'Last push', type: 'datetime', system: true},
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
	form: 'server',
	actions: [],
	collections: [],
};

export const CHAT_INTEGRATION_ID = 'chat';

/** Where a thread stands, as its record says it and a list of threads is narrowed by: the Chat page's own words, and Archived for one the person archived, which the Chat page's list leaves out. */
export const CHAT_STANDINGS = {
	in_progress: 'In progress',
	waiting: 'Waiting for you',
	done: 'Done',
	archived: 'Archived',
} as const;

// Chat: the person's own threads with their agents on the Chat page, and the alerts set in them,
// as records, so that an agent can be asked about the others: what waits for the person, what was
// found in one, which alerts are set. Every member has one, theirs alone, as they have a vault,
// made once the organization has used Chat. A thread is read, never written: whoever reads one
// points the person to it by its url, its page in Chat, and they go on there. An alert is seen and
// cancelled; one is set in a thread, by its agent, since it comes back to that thread.
const chat: Integration = {
	id: CHAT_INTEGRATION_ID,
	name: 'Chat',
	description: 'Your threads with your agents on the Chat page, and the alerts set in them',
	native: true,
	actions: [
		{
			id: 'readThreads',
			label: 'Read threads',
			description: 'List your threads in Chat and read what was said in them',
			risk: 'low',
		},
		{
			id: 'readAlerts',
			label: 'See alerts',
			description: 'List the alerts set in your threads',
			risk: 'low',
		},
		{
			id: 'cancelAlerts',
			label: 'Cancel alerts',
			description: 'Cancel an alert, which then never comes',
			risk: 'medium',
			requires: 'readAlerts',
		},
	],
	collections: [
		{
			id: 'threads',
			name: 'Threads',
			singular: 'thread',
			titleField: 'title',
			summaryField: 'summary',
			filterField: 'standing',
			openIn: 'Chat',
			read: 'readThreads',
			writes: {},
			searchHint: 'Matches the words in the title or the summary, in any case.',
			fields: [
				{key: 'title', label: 'Title', type: 'text', system: true},
				{key: 'agent', label: 'Agent', type: 'text', system: true},
				{
					key: 'standing',
					label: 'Standing',
					type: 'select',
					options: Object.values(CHAT_STANDINGS),
					system: true,
				},
				{key: 'summary', label: 'Summary', type: 'longtext', system: true},
				{key: 'lastMessageAt', label: 'Last message', type: 'datetime', system: true},
				{key: 'messages', label: 'Messages', type: 'longtext', system: true},
			],
		},
		{
			id: 'alerts',
			name: 'Alerts',
			singular: 'alert',
			titleField: 'title',
			summaryField: 'comes',
			openIn: 'Chat',
			read: 'readAlerts',
			writes: {delete: 'cancelAlerts'},
			fields: [
				{key: 'title', label: 'Title', type: 'text', system: true},
				{key: 'comes', label: 'Comes', type: 'text', system: true},
				{key: 'note', label: 'Note', type: 'longtext', system: true},
				{key: 'thread', label: 'Thread', type: 'text', system: true},
				{key: 'agent', label: 'Agent', type: 'text', system: true},
			],
		},
	],
};

/**
 * What the organization's built-in agent, which the Chat page's personas act through, may do with
 * a member's Chat by default: everything. Any other agent starts with nothing, since a thread may
 * say what came from a connection that agent was never given.
 */
export const CHAT_BUILT_IN_ACTIONS: string[] = chat.actions.map((action) => action.id);

export const INTEGRATIONS: Integration[] = [
	vault,
	email,
	google,
	granola,
	notion,
	linear,
	github,
	cloudflare,
	exa,
	parallel,
	plaid,
	postgres,
	mysql,
	sandbox,
	files,
	chat,
	mcp,
];

export function findIntegration(id: string): Integration | undefined {
	return INTEGRATIONS.find((integration) => integration.id === id);
}

/** Whether an organization can connect the integration: it is behind no experiment, or one it has on. */
export function isOffered(
	integration: Pick<Integration, 'experiment'>,
	holder: {experiments: Experiment[]},
): boolean {
	return !integration.experiment || hasExperiment(holder, integration.experiment);
}

export function findCollection<T extends {collections: Collection[]}>(
	integration: T,
	id: string,
): Collection | undefined {
	return integration.collections.find((collection) => collection.id === id);
}
