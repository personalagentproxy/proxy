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

export const INTEGRATIONS: Integration[] = [info, email];

export function findIntegration(id: string): Integration | undefined {
	return INTEGRATIONS.find((integration) => integration.id === id);
}

export function findCollection<T extends {collections: Collection[]}>(
	integration: T,
	id: string,
): Collection | undefined {
	return integration.collections.find((collection) => collection.id === id);
}
