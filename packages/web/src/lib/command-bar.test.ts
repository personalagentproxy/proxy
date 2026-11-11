/// <reference types="bun" />

import type {AgentLogin} from '@proxy/contracts/agents';
import type {Connection} from '@proxy/contracts/connections';
import type {ChatPersona} from '@proxy/contracts/harness';
import {describe, expect, test} from 'bun:test';
import {addressedPersona, destinationsOf, findDestinations, personaFor} from '@/lib/command-bar';

const look = {nose: 0.48, noseOut: 0.35, eye: 27, eyeTheta: 55, eyeLat: 8, eyes: 2 as const};

function persona(
	id: string,
	name: string,
	shared = false,
	createdAt = '2026-10-20T10:00:00Z',
): ChatPersona {
	return {
		id,
		name,
		shared,
		mayChange: true,
		look,
		color: 'blue',
		harness: 'proxy',
		chatModel: 'claude',
		lastMessage: null,
		draft: null,
		createdAt,
	};
}

function connection(id: string, integrationId: string, account: string): Connection {
	return {
		id,
		orgId: 'org-1',
		integrationId,
		account,
		ownerUserId: 'user-1',
		owner: 'Alex',
		sharedWithEveryone: false,
		sharedWith: [],
		shared: false,
		builtIn: integrationId === 'vault',
		defaults: [],
		tools: null,
		name: null,
		unavailable: [],
		signInNeeded: false,
	};
}

function agent(id: string, name: string, revokedAt: string | null = null): AgentLogin {
	return {
		id,
		providerId: 'claude',
		name,
		username: id,
		shared: false,
		createdById: 'user-1',
		createdBy: null,
		createdAt: '2026-10-01T00:00:00.000Z',
		lastActiveAt: null,
		revokedAt,
		grants: [],
	};
}

const general = persona('p-general', 'General', true, '2026-01-01T00:00:00Z');
const finance = persona('p-finance', 'Finance');
const team = persona('p-team', 'Finance team');
const personas = [finance, team, general];

const everywhere = destinationsOf({
	org: 'acme',
	personas,
	connections: [
		connection('vault-1', 'vault', 'Acme'),
		connection('google-1', 'google', 'me@example.com'),
		connection('google-2', 'google', 'me@home.example'),
		connection('granola-1', 'granola', 'me@example.com'),
	],
	agents: [agent('a1', 'Claude'), agent('a2', 'Old login', '2026-10-02T00:00:00.000Z')],
});

function found(typed: string): string[] {
	return findDestinations(typed, everywhere).map((destination) => destination.label);
}

describe('destinationsOf', () => {
	test('lists the pages, the conversations, the connections and the external agents not revoked, each where it is', () => {
		const to = Object.fromEntries(
			everywhere.map((destination) => [destination.label, destination.to]),
		);
		expect(to).toMatchObject({
			Chat: '/acme/chat',
			Account: '/account?org=acme',
			'Add a connection': '/acme/connections/new',
			Finance: '/acme/chat/p-finance',
			'My vault': '/acme/connections/vault-1',
			Granola: '/acme/connections/granola-1',
			'Google (me@home.example)': '/acme/connections/google-2',
			Claude: '/acme/agents/a1',
		});
		expect(to['Old login']).toBeUndefined();
		expect(to.Home).toBeUndefined();
	});

	test('says a connection’s account beside its name, unless the name has it or it is the organization’s own', () => {
		const detail = Object.fromEntries(
			everywhere.map((destination) => [destination.label, destination.detail]),
		);
		expect(detail.Granola).toBe('me@example.com');
		expect(detail['Google (me@home.example)']).toBeNull();
		expect(detail['My vault']).toBeNull();
	});
});

describe('findDestinations', () => {
	test('finds what every word typed starts a word of, the label that starts with it first', () => {
		expect(found('gra')).toEqual(['Granola']);
		expect(found('conn perm')).toEqual(['Connections and permissions']);
		expect(found('fin')).toEqual(['Finance', 'Finance team']);
		expect(found('ACT')).toEqual(['Activity']);
	});

	test('finds a destination by its account and by what else it is known as', () => {
		expect(found('me@home')).toEqual(['Google (me@home.example)']);
		expect(found('invite')).toEqual(['Members']);
		expect(found('sign out')).toEqual(['Account']);
	});

	test('finds nothing for a sentence, which is for a quick action or an agent, nor for nothing typed', () => {
		expect(found('book lunch with Jacky tomorrow at 1')).toEqual([]);
		expect(found('add an agent that reminds me to stretch')).toEqual([]);
		expect(found('   ')).toEqual([]);
	});
});

describe('addressedPersona', () => {
	test('is the agent a text is said to by name, and what is said to it, without the name', () => {
		const said = (text: string) => {
			const addressed = addressedPersona(text, personas);
			return addressed && [addressed.persona.id, addressed.message];
		};
		expect(said('@Finance how much runway do we have')).toEqual([
			'p-finance',
			'how much runway do we have',
		]);
		expect(said('ask finance how much runway we have')).toEqual([
			'p-finance',
			'how much runway we have',
		]);
		expect(said('ask Finance to pay the invoice ')).toEqual(['p-finance', 'pay the invoice']);
		expect(said('Tell Finance: pay the invoice')).toEqual(['p-finance', 'pay the invoice']);
		expect(said('tell finance that the invoice is paid')).toEqual([
			'p-finance',
			'the invoice is paid',
		]);
		expect(said('Finance, what did we spend on travel?')).toEqual([
			'p-finance',
			'what did we spend on travel?',
		]);
		expect(said('finance: to do or not to do')).toEqual(['p-finance', 'to do or not to do']);
		expect(said('hey @finance what is up')).toEqual(['p-finance', 'what is up']);
	});

	test('is the agent named as "my … agent", "the … assistant" and the like', () => {
		const said = (text: string) => {
			const addressed = addressedPersona(text, personas);
			return addressed && [addressed.persona.id, addressed.message];
		};
		expect(said('ask my general agent what he thinks of me')).toEqual([
			'p-general',
			'what he thinks of me',
		]);
		expect(said('tell the finance assistant to pay the invoice')).toEqual([
			'p-finance',
			'pay the invoice',
		]);
		expect(said('ask our finance team bot about the budget')).toEqual([
			'p-team',
			'about the budget',
		]);
		expect(said('@finance agent how much runway do we have')).toEqual([
			'p-finance',
			'how much runway do we have',
		]);
		expect(said('Finance agent, what did we spend on travel?')).toEqual([
			'p-finance',
			'what did we spend on travel?',
		]);
	});

	test('is the longest name said, and none where the name is only part of a word or of the sentence', () => {
		expect(addressedPersona('ask finance team about the budget', personas)).toEqual({
			persona: team,
			message: 'about the budget',
		});
		expect(addressedPersona('ask financers about the budget', personas)).toBeNull();
		expect(addressedPersona('finance report for March', personas)).toBeNull();
		expect(addressedPersona('what does finance think', personas)).toBeNull();
	});

	test('is none while nothing is said to it yet', () => {
		expect(addressedPersona('ask finance', personas)).toBeNull();
		expect(addressedPersona('@finance ', personas)).toBeNull();
		expect(addressedPersona('ask my finance agent', personas)).toBeNull();
		expect(addressedPersona('ask the finance bot ', personas)).toBeNull();
	});
});

describe('personaFor', () => {
	test('is General, the one every member sees, unless the text names another', () => {
		expect(personaFor('summarize my week', personas)?.id).toBe('p-general');
		expect(personaFor('what does finance think of the offer', personas)?.id).toBe('p-finance');
		expect(personaFor('ask finance team about the budget', personas)?.id).toBe('p-team');
	});

	test('is the oldest of those every member sees, else the conversation last active, else none', () => {
		const older = persona('p-older', 'Everyone', true, '2025-06-01T00:00:00Z');
		expect(personaFor('hello', [finance, general, older])?.id).toBe('p-older');
		expect(personaFor('hello', [team, finance])?.id).toBe('p-team');
		expect(personaFor('hello', [])).toBeNull();
	});
});
