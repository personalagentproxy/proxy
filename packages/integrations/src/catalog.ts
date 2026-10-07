import type {Action, Collection, Integration} from './types';

export const INFO_INTEGRATION_ID = 'info';

function read(description: string): Action {
	return {id: 'read', label: 'Read', description, risk: 'low'};
}

// Information's collections: read, and create, edit and delete as one.
function infoActions(plural: string): Pick<Collection, 'actions' | 'presets' | 'writes'> {
	return {
		actions: [
			read(`List and open ${plural}`),
			{id: 'write', label: 'Write', description: `Add, edit and delete ${plural}`, risk: 'medium'},
		],
		presets: [{label: 'Read & write', actions: ['read', 'write']}],
		writes: {create: 'write', update: 'write', delete: 'write'},
	};
}

// Any mailbox over IMAP and SMTP, signed in with an app password. The password can't be limited,
// so access is only ever narrowed in Proxy. Received emails can't be edited, only acted on: marked,
// flagged, archived or moved to Trash, never deleted for good. Mail goes out only as a sent draft,
// so every sent email existed first as something to read and the log can name.
const email: Integration = {
	id: 'email',
	name: 'Email',
	description: 'Emails, drafts and sent mail from Gmail, iCloud, Fastmail or any IMAP mailbox',
	collections: [
		{
			id: 'emails',
			name: 'Emails',
			singular: 'email',
			titleField: 'subject',
			summaryField: 'from',
			actions: [
				read('List and open emails in the inbox'),
				{
					id: 'mark',
					label: 'Mark read or unread',
					description: 'Mark emails read or unread',
					risk: 'low',
				},
				{id: 'flag', label: 'Flag', description: 'Flag and unflag emails', risk: 'low'},
				{
					id: 'archive',
					label: 'Archive',
					description: 'Move emails out of the inbox into the archive',
					risk: 'medium',
				},
				{
					id: 'trash',
					label: 'Move to Trash',
					description: 'Move emails to Trash, where they can be restored from',
					risk: 'high',
				},
			],
			presets: [{label: 'Read & triage', actions: ['read', 'mark', 'flag', 'archive']}],
			writes: {},
			commands: [
				{
					id: 'markRead',
					label: 'Mark as read',
					action: 'mark',
					done: 'Marked {} as read',
					tried: 'mark {} as read',
				},
				{
					id: 'markUnread',
					label: 'Mark as unread',
					action: 'mark',
					done: 'Marked {} as unread',
					tried: 'mark {} as unread',
				},
				{id: 'flag', label: 'Flag', action: 'flag', done: 'Flagged {}', tried: 'flag {}'},
				{id: 'unflag', label: 'Unflag', action: 'flag', done: 'Unflagged {}', tried: 'unflag {}'},
				{
					id: 'archive',
					label: 'Archive',
					action: 'archive',
					done: 'Archived {}',
					tried: 'archive {}',
				},
				{
					id: 'trash',
					label: 'Move to Trash',
					action: 'trash',
					done: 'Moved {} to Trash',
					tried: 'move {} to Trash',
				},
			],
			fields: [
				{key: 'from', label: 'From', type: 'email', system: true},
				{key: 'to', label: 'To', type: 'email'},
				{key: 'subject', label: 'Subject', type: 'text'},
				{key: 'receivedAt', label: 'Received', type: 'datetime', system: true},
				// "Unread, Flagged", from the message's flags.
				{key: 'status', label: 'Status', type: 'text', system: true},
				{key: 'body', label: 'Body', type: 'longtext'},
			],
		},
		{
			id: 'drafts',
			name: 'Drafts',
			singular: 'draft',
			titleField: 'subject',
			summaryField: 'to',
			actions: [
				read('List and open drafts'),
				{
					id: 'write',
					label: 'Write drafts',
					description: 'Create, edit and delete drafts',
					risk: 'medium',
				},
				{id: 'send', label: 'Send', description: 'Send drafts to their recipients', risk: 'high'},
			],
			presets: [{label: 'Read & write', actions: ['read', 'write']}],
			writes: {create: 'write', update: 'write', delete: 'write'},
			commands: [{id: 'send', label: 'Send', action: 'send', done: 'Sent {}', tried: 'send {}'}],
			fields: [
				{key: 'to', label: 'To', type: 'email'},
				{key: 'subject', label: 'Subject', type: 'text'},
				{key: 'body', label: 'Body', type: 'longtext'},
			],
		},
		{
			id: 'sent',
			name: 'Sent',
			singular: 'sent email',
			titleField: 'subject',
			summaryField: 'to',
			actions: [read('List and open emails sent from the mailbox')],
			writes: {},
			fields: [
				{key: 'to', label: 'To', type: 'email', system: true},
				{key: 'subject', label: 'Subject', type: 'text', system: true},
				{key: 'sentAt', label: 'Sent', type: 'datetime', system: true},
				{key: 'body', label: 'Body', type: 'longtext', system: true},
			],
		},
	],
};

const info: Integration = {
	id: INFO_INTEGRATION_ID,
	name: 'Information',
	description: 'Details you keep in Proxy for agents to use',
	builtIn: true,
	collections: [
		{
			id: 'addresses',
			name: 'Addresses',
			singular: 'address',
			titleField: 'label',
			summaryField: 'city',
			...infoActions('addresses'),
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
			...infoActions('payment cards'),
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
			...infoActions('notes'),
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
