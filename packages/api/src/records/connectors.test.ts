import {describe, expect, mock, test} from 'bun:test';

import {INTEGRATIONS, type Collection} from '@proxy/integrations';

import type {Capability} from './capabilities';
import {isRecordStore, type Connector} from './connector';

// Only the connectors are looked at here, never run: nothing reads the environment.
mock.module('../utils/env', () => ({env: {}}));

const {connectorFor} = await import('./connectors');

// A connector has the methods and runners of what its collection offers, and only those: the gate
// and the records routes refuse what the catalog doesn't offer before a connector is called, and
// this is what makes sure a connector can do what they let through.

// What the catalog offers of a collection, each as the connector's method or runner doing it.
function declared(collection: Collection): string[] {
	const {writes, commands = []} = collection;
	return [
		...(collection.read ? ['list', 'get'] : []),
		...(writes.create ? ['create'] : []),
		...(writes.update ? ['update'] : []),
		...(writes.delete ? ['remove'] : []),
		...commands.map((command) => `${command.on}:${command.id}`),
	].sort();
}

// What a connector does, named the same way.
function offered(connector: Connector): string[] {
	if (!isRecordStore(connector)) {
		return Object.keys(connector.newCommands)
			.map((id) => `new:${id}`)
			.sort();
	}
	return [
		'list',
		'get',
		...(connector.create ? ['create'] : []),
		...(connector.update ? ['update'] : []),
		...(connector.remove ? ['remove'] : []),
		...Object.keys(connector.commands ?? {}).map((id) => `record:${id}`),
		...Object.keys(connector.newCommands ?? {}).map((id) => `new:${id}`),
	].sort();
}

// The members a connector has besides its capabilities: those `offered` names.
const MEMBERS = ['list', 'get', 'create', 'update', 'remove', 'commands', 'newCommands'];

// The collections each capability belongs to, those whose records it reads or writes; `any` for one
// every collection may have. A widget works with every connector of the collection that has it.
const WHERE: Record<Capability, string[] | 'any'> = {
	findEmails: ['emails'],
	reply: ['emails'],
	balances: ['accounts'],
	transactionsBetween: ['transactions'],
	agenda: ['events'],
	findEvents: ['events'],
	meetings: ['notes'],
	findFiles: ['files'],
	readText: 'any',
};

function isCapability(key: string): key is Capability {
	return key in WHERE;
}

// The capabilities a connector has, and anything else it has that is neither one nor a member.
function extras(connector: Connector): {capabilities: Capability[]; others: string[]} {
	const keys = Object.keys(connector).filter((key) => !MEMBERS.includes(key));
	return {capabilities: keys.filter(isCapability), others: keys.filter((key) => !isCapability(key))};
}

const COLLECTIONS = INTEGRATIONS.flatMap((integration) => integration.collections.map((collection) => ({integrationId: integration.id, collection})));

describe('connectorFor', () => {
	for (const {integrationId, collection} of COLLECTIONS) {
		test(`${integrationId}/${collection.id} has a connector doing what the catalog offers, and nothing else`, () => {
			const connector = connectorFor(integrationId, collection.id);
			if (!connector) {
				throw new Error(`No connector for ${integrationId}/${collection.id}`);
			}
			expect(offered(connector)).toEqual(declared(collection));
		});
	}

	for (const {integrationId, collection} of COLLECTIONS) {
		test(`${integrationId}/${collection.id} has only the capabilities of its collection`, () => {
			const connector = connectorFor(integrationId, collection.id);
			if (!connector) {
				throw new Error(`No connector for ${integrationId}/${collection.id}`);
			}
			const {capabilities, others} = extras(connector);
			expect(others).toEqual([]);
			expect(
				capabilities.filter((capability) => {
					const where = WHERE[capability];
					return where !== 'any' && !where.includes(collection.id);
				}),
			).toEqual([]);
		});
	}

	test('a mailbox replies for the widget where its integration has replies, which are written the same way', () => {
		for (const integration of INTEGRATIONS) {
			const emails = connectorFor(integration.id, 'emails');
			if (!emails || !isRecordStore(emails)) {
				continue;
			}
			const replies = integration.collections.some((collection) => collection.id === 'replies');
			expect([integration.id, emails.reply !== undefined]).toEqual([integration.id, replies]);
		}
	});

	test('a custom MCP server, a collection the catalog lacks, and an integration it lacks have none', () => {
		expect(connectorFor('mcp', 'tools')).toBeUndefined();
		expect(connectorFor('google', 'photos')).toBeUndefined();
		expect(connectorFor('dropbox', 'files')).toBeUndefined();
	});
});
