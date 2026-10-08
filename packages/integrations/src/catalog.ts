import type {Action, Collection, Condition, Integration} from './types';

const INBOX: Condition = {field: 'folder', values: ['Inbox']};

export const INFO_INTEGRATION_ID = 'info';

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
			id: 'trash',
			label: 'Move to Trash',
			description: 'Move emails to Trash, where they can be restored from',
			risk: 'high',
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
			id: 'send',
			label: 'Send',
			description: 'Send email from this address, new or from a draft',
			risk: 'high',
			reachesOthers: true,
		},
	],
	collections: [
		{
			id: 'emails',
			name: 'Email',
			singular: 'email',
			titleField: 'subject',
			summaryField: 'from',
			filterField: 'folder',
			searchHint:
				'On Gmail, Gmail’s own search syntax works, such as from:sam has:attachment newer_than:7d. Other mailboxes match the words in the sender, recipients, subject and text.',
			read: 'read',
			createLabel: 'Save as draft',
			writes: {create: 'write', update: 'write', delete: 'write'},
			editable: {field: 'folder', values: ['Draft']},
			commands: [
				{
					id: 'markRead',
					on: 'record',
					label: 'Mark as read',
					action: 'mark',
					where: INBOX,
					done: 'Marked {} as read',
					tried: 'mark {} as read',
				},
				{
					id: 'markUnread',
					on: 'record',
					label: 'Mark as unread',
					action: 'mark',
					where: INBOX,
					done: 'Marked {} as unread',
					tried: 'mark {} as unread',
				},
				{
					id: 'flag',
					on: 'record',
					label: 'Flag',
					action: 'flag',
					where: INBOX,
					done: 'Flagged {}',
					tried: 'flag {}',
				},
				{
					id: 'unflag',
					on: 'record',
					label: 'Unflag',
					action: 'flag',
					where: INBOX,
					done: 'Unflagged {}',
					tried: 'unflag {}',
				},
				{
					id: 'archive',
					on: 'record',
					label: 'Archive',
					action: 'archive',
					where: INBOX,
					done: 'Archived {}',
					tried: 'archive {}',
				},
				{
					id: 'trash',
					on: 'record',
					label: 'Move to Trash',
					action: 'trash',
					where: INBOX,
					done: 'Moved {} to Trash',
					tried: 'move {} to Trash',
				},
				{
					id: 'send',
					on: 'record',
					label: 'Send',
					action: 'send',
					where: {field: 'folder', values: ['Draft']},
					done: 'Sent {}',
					tried: 'send {}',
				},
				{
					id: 'sendNew',
					on: 'new',
					label: 'Send',
					action: 'send',
					done: 'Sent {}',
					tried: 'send {}',
				},
			],
			fields: [
				{
					key: 'folder',
					label: 'Folder',
					type: 'select',
					options: ['Inbox', 'Draft', 'Sent'],
					system: true,
				},
				{key: 'from', label: 'From', type: 'email', system: true},
				{key: 'to', label: 'To', type: 'email'},
				{key: 'subject', label: 'Subject', type: 'text'},
				{key: 'date', label: 'Date', type: 'datetime', system: true},
				// "Unread, Flagged", from the flags of an email in the inbox.
				{key: 'status', label: 'Status', type: 'text', system: true},
				{key: 'body', label: 'Body', type: 'longtext'},
			],
		},
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
			read: 'readNotes',
			writes: {},
			fields: [
				{key: 'title', label: 'Title', type: 'text', system: true},
				// As Granola writes it, in the account's time zone: "Sep 22, 2026 11:00 AM PDT".
				{key: 'date', label: 'Date', type: 'text', system: true},
				// As Granola writes them: "Alex (note creator) from Acme <alex@acme.com>, Sam <sam@example.com>".
				{key: 'attendees', label: 'Attendees', type: 'text', system: true},
				// The note in Granola's web app.
				{key: 'link', label: 'Link', type: 'text', system: true},
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
				// The page in Notion.
				{key: 'link', label: 'Link', type: 'text', system: true},
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

export const INTEGRATIONS: Integration[] = [info, email, granola, notion];

export function findIntegration(id: string): Integration | undefined {
	return INTEGRATIONS.find((integration) => integration.id === id);
}

export function findCollection<T extends {collections: Collection[]}>(
	integration: T,
	id: string,
): Collection | undefined {
	return integration.collections.find((collection) => collection.id === id);
}
