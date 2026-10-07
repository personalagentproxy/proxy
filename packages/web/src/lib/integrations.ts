import {IdCardIcon, LayoutGridIcon, NotebookTextIcon, SquareKanbanIcon} from 'lucide-react';
import type {Collection, Integration} from '@/lib/types';

export const INFO_INTEGRATION_ID = 'info';

// Every Google product is a collection of one Workspace connection: one sign-in, and access is
// still given product by product.
const google: Integration = {
	id: 'google',
	name: 'Google Workspace',
	description: 'Gmail, Calendar, Contacts, Drive, Docs and Sheets',
	logoUrl: '/integrations/google.png',
	icon: LayoutGridIcon,
	sampleAccount: 'alex.weber@gmail.com',
	collections: [
		{
			id: 'emails',
			name: 'Emails',
			singular: 'email',
			titleField: 'subject',
			summaryField: 'from',
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
		{
			id: 'events',
			name: 'Calendar events',
			singular: 'event',
			titleField: 'title',
			summaryField: 'start',
			fields: [
				{key: 'title', label: 'Title', type: 'text'},
				{key: 'start', label: 'Starts', type: 'datetime'},
				{key: 'end', label: 'Ends', type: 'datetime'},
				{key: 'location', label: 'Location', type: 'text'},
				{key: 'attendees', label: 'Attendees', type: 'text'},
				{key: 'notes', label: 'Notes', type: 'longtext'},
			],
		},
		{
			id: 'contacts',
			name: 'Contacts',
			singular: 'contact',
			titleField: 'name',
			summaryField: 'email',
			fields: [
				{key: 'name', label: 'Name', type: 'text'},
				{key: 'email', label: 'Email', type: 'email'},
				{key: 'phone', label: 'Phone', type: 'text'},
				{key: 'company', label: 'Company', type: 'text'},
			],
		},
		{
			id: 'files',
			name: 'Drive files',
			singular: 'file',
			titleField: 'name',
			summaryField: 'kind',
			fields: [
				{key: 'name', label: 'Name', type: 'text'},
				{key: 'kind', label: 'Kind', type: 'select', options: ['Folder', 'PDF', 'Image', 'Other']},
				{key: 'folder', label: 'Folder', type: 'text'},
				{key: 'modifiedAt', label: 'Modified', type: 'datetime', system: true},
			],
		},
		{
			id: 'docs',
			name: 'Docs',
			singular: 'doc',
			titleField: 'title',
			fields: [
				{key: 'title', label: 'Title', type: 'text'},
				{key: 'body', label: 'Body', type: 'longtext'},
			],
		},
		{
			id: 'sheets',
			name: 'Sheets',
			singular: 'sheet',
			titleField: 'title',
			fields: [
				{key: 'title', label: 'Title', type: 'text'},
				{key: 'cells', label: 'Cells (CSV)', type: 'longtext'},
			],
		},
	],
};

const notion: Integration = {
	id: 'notion',
	name: 'Notion',
	description: 'Pages and database entries',
	logoUrl: '/integrations/notion.ico',
	icon: NotebookTextIcon,
	sampleAccount: "Alex's workspace",
	collections: [
		{
			id: 'pages',
			name: 'Pages',
			singular: 'page',
			titleField: 'title',
			summaryField: 'parent',
			fields: [
				{key: 'title', label: 'Title', type: 'text'},
				{key: 'parent', label: 'Parent page', type: 'text'},
				{key: 'body', label: 'Body', type: 'longtext'},
			],
		},
		{
			id: 'entries',
			name: 'Database entries',
			singular: 'entry',
			titleField: 'name',
			summaryField: 'database',
			fields: [
				{key: 'name', label: 'Name', type: 'text'},
				{key: 'database', label: 'Database', type: 'text'},
				{
					key: 'status',
					label: 'Status',
					type: 'select',
					options: ['Not started', 'In progress', 'Done'],
				},
				{key: 'due', label: 'Due', type: 'date'},
			],
		},
	],
};

const linear: Integration = {
	id: 'linear',
	name: 'Linear',
	description: 'Issues and projects',
	logoUrl: '/integrations/linear.ico',
	icon: SquareKanbanIcon,
	sampleAccount: 'Northwind',
	collections: [
		{
			id: 'issues',
			name: 'Issues',
			singular: 'issue',
			titleField: 'title',
			summaryField: 'status',
			fields: [
				{key: 'title', label: 'Title', type: 'text'},
				{
					key: 'status',
					label: 'Status',
					type: 'select',
					options: ['Backlog', 'Todo', 'In Progress', 'Done', 'Canceled'],
				},
				{
					key: 'priority',
					label: 'Priority',
					type: 'select',
					options: ['No priority', 'Urgent', 'High', 'Medium', 'Low'],
				},
				{key: 'assignee', label: 'Assignee', type: 'text'},
				{key: 'description', label: 'Description', type: 'longtext'},
			],
		},
		{
			id: 'projects',
			name: 'Projects',
			singular: 'project',
			titleField: 'name',
			summaryField: 'status',
			fields: [
				{key: 'name', label: 'Name', type: 'text'},
				{
					key: 'status',
					label: 'Status',
					type: 'select',
					options: ['Planned', 'In progress', 'Completed'],
				},
				{key: 'lead', label: 'Lead', type: 'text'},
				{key: 'targetDate', label: 'Target date', type: 'date'},
			],
		},
	],
};

const info: Integration = {
	id: INFO_INTEGRATION_ID,
	name: 'Information',
	description: 'Details you keep in Proxy for agents to use',
	logoUrl: '/integrations/information.svg',
	icon: IdCardIcon,
	sampleAccount: 'Stored in Proxy',
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

export const INTEGRATIONS: Integration[] = [info, google, notion, linear];

export function findIntegration(id: string): Integration | undefined {
	return INTEGRATIONS.find((integration) => integration.id === id);
}

export function findCollection(integration: Integration, id: string): Collection | undefined {
	return integration.collections.find((collection) => collection.id === id);
}
