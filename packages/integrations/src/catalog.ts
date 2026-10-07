import type {Collection, Integration} from './types';

export const INFO_INTEGRATION_ID = 'info';

// Any mailbox over IMAP and SMTP, signed in with an app password. The password can't be limited,
// so access is only ever narrowed in Proxy.
const email: Integration = {
	id: 'email',
	name: 'Email',
	description: 'Emails, drafts and sending, from Gmail, iCloud, Fastmail or any IMAP mailbox',
	collections: [
		{
			id: 'emails',
			name: 'Emails',
			singular: 'email',
			titleField: 'subject',
			summaryField: 'from',
			writeActions: [],
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
			fields: [
				{key: 'to', label: 'To', type: 'email'},
				{key: 'subject', label: 'Subject', type: 'text'},
				{key: 'body', label: 'Body', type: 'longtext'},
			],
		},
		// Writing here sends an email, so sending is given on its own, apart from drafts. What was
		// sent can be read, never changed.
		{
			id: 'sent',
			name: 'Sent emails',
			singular: 'email',
			titleField: 'subject',
			summaryField: 'to',
			writeActions: ['create'],
			createVerb: {present: 'Send', past: 'Sent'},
			fields: [
				{key: 'to', label: 'To', type: 'email'},
				{key: 'subject', label: 'Subject', type: 'text'},
				{key: 'sentAt', label: 'Sent', type: 'datetime', system: true},
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
