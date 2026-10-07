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
// so access is only ever narrowed in Proxy.
const email: Integration = {
	id: 'email',
	name: 'Email',
	description: 'Emails and drafts from Gmail, iCloud, Fastmail or any IMAP mailbox',
	collections: [
		{
			id: 'emails',
			name: 'Emails',
			singular: 'email',
			titleField: 'subject',
			summaryField: 'from',
			actions: [read('List, search and open emails in the inbox')],
			writes: {},
			fields: [
				{key: 'from', label: 'From', type: 'email', system: true},
				{key: 'to', label: 'To', type: 'email'},
				{key: 'subject', label: 'Subject', type: 'text'},
				{key: 'receivedAt', label: 'Received', type: 'datetime', system: true},
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
				{id: 'write', label: 'Write drafts', description: 'Create, edit and delete drafts', risk: 'medium'},
			],
			presets: [{label: 'Read & write', actions: ['read', 'write']}],
			writes: {create: 'write', update: 'write', delete: 'write'},
			fields: [
				{key: 'to', label: 'To', type: 'email'},
				{key: 'subject', label: 'Subject', type: 'text'},
				{key: 'body', label: 'Body', type: 'longtext'},
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
