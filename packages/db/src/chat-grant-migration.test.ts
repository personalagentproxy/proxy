import {readdirSync, readFileSync} from 'node:fs';

import {PGlite} from '@electric-sql/pglite';
import {afterAll, beforeAll, describe, expect, test} from 'bun:test';

// The migrations that grant the built-in agent an action Chat gained, on the Chat connections made
// before it (v081 Mark done and archive, v082 Write in threads), each run on rows as they were: a
// database of its own, in this process, which PGlite keeps in memory, made with every migration
// before it, as general-maker-migration.test.ts makes one. Nothing here needs the local database.
// An action Chat gains later is granted by a migration as these are, and tested by adding it here.
const GRANTS = [
	{migration: 'v081_grant_chat_mark_threads', actionId: 'markThreads'},
	{migration: 'v082_grant_chat_write_threads', actionId: 'writeThreads'},
];

const migrations = new URL('../prisma/migrations/', import.meta.url);

function migrationSql(name: string): string {
	return readFileSync(new URL(`${name}/migration.sql`, migrations), 'utf8');
}

type Value = string | boolean | null;

type GrantRow = {agentId: string; connectionId: string; actionId: string; allowed: boolean};

for (const {migration, actionId} of GRANTS) {
	// Prisma applies the migrations in the order their names sort as text (migrations.test.ts).
	const before = readdirSync(migrations, {withFileTypes: true})
		.filter((entry) => entry.isDirectory() && entry.name < migration)
		.map((entry) => entry.name)
		.sort();

	const pg = new PGlite();

	async function insert(table: string, row: Record<string, Value>): Promise<void> {
		const columns = Object.keys(row);
		await pg.query(
			`INSERT INTO "${table}" (${columns.map((column) => `"${column}"`).join(', ')}) VALUES (${columns.map((_, index) => `$${index + 1}`).join(', ')})`,
			Object.values(row),
		);
	}

	async function grantsOf(connectionId: string): Promise<GrantRow[]> {
		return (
			await pg.query<GrantRow>(
				`SELECT "agentId", "connectionId", "actionId", "allowed" FROM "AgentGrant" WHERE "connectionId" = $1 ORDER BY "agentId", "actionId"`,
				[connectionId],
			)
		).rows;
	}

	async function agent(id: string, providerId: string, ownerUserId: string | null): Promise<void> {
		await insert('Agent', {
			id,
			orgId: 'harbor',
			providerId,
			name: id,
			username: id,
			passwordHash: 'x',
			ownerUserId,
		});
	}

	async function grant(
		agentId: string,
		connectionId: string,
		granted: string,
		allowed: boolean,
	): Promise<void> {
		await insert('AgentGrant', {
			id: `${agentId}-${connectionId}-${granted}`,
			agentId,
			connectionId,
			actionId: granted,
			allowed,
		});
	}

	// Harbor's members, each with their Chat as it was before: Lena's as it was made, Omar's with
	// Cancel alerts turned off for the built-in agent, Ruth's with Read threads turned off, and Ivo's
	// with Read threads dropped back to the connection's default, which is off. Lena's own agent
	// reads her threads too, and the built-in agent reads her vault, which is no Chat.
	async function seed(): Promise<void> {
		for (const id of ['lena', 'omar', 'ruth', 'ivo']) {
			await insert('User', {id, email: `${id}@example.com`});
		}
		await insert('Organization', {
			id: 'harbor',
			name: 'Harbor',
			slug: 'harbor',
			ownerUserId: 'lena',
		});
		await agent('built-in', 'proxy', null);
		await agent('lena-dot', 'dot', 'lena');
		for (const member of ['lena', 'omar', 'ruth', 'ivo']) {
			await insert('Connection', {
				id: `${member}-chat`,
				orgId: 'harbor',
				integrationId: 'chat',
				account: 'Harbor',
				ownerUserId: member,
			});
		}
		await insert('Connection', {
			id: 'lena-vault',
			orgId: 'harbor',
			integrationId: 'vault',
			account: 'Harbor',
			ownerUserId: 'lena',
		});
		for (const granted of ['readThreads', 'readAlerts', 'cancelAlerts']) {
			await grant('built-in', 'lena-chat', granted, true);
			await grant('built-in', 'omar-chat', granted, granted !== 'cancelAlerts');
			await grant('built-in', 'ruth-chat', granted, granted !== 'readThreads');
		}
		await grant('built-in', 'ivo-chat', 'readAlerts', true);
		await grant('lena-dot', 'lena-chat', 'readThreads', true);
		await grant('built-in', 'lena-vault', 'readThreads', true);
	}

	beforeAll(async () => {
		for (const name of before) {
			await pg.exec(migrationSql(name));
		}
		await seed();
		await pg.exec(migrationSql(migration));
	});

	afterAll(async () => {
		await pg.close();
	});

	describe(migration, () => {
		test(`grants the built-in agent ${actionId} on each Chat connection where it reads the threads, whatever else was turned off`, async () => {
			for (const connectionId of ['lena-chat', 'omar-chat']) {
				expect(await grantsOf(connectionId)).toContainEqual({
					agentId: 'built-in',
					connectionId,
					actionId,
					allowed: true,
				});
			}
			expect(
				(await grantsOf('omar-chat')).find((row) => row.actionId === 'cancelAlerts')?.allowed,
			).toBe(false);
		});

		test('leaves a Chat whose member stopped the built-in agent reading its threads as it is', async () => {
			for (const connectionId of ['ruth-chat', 'ivo-chat']) {
				expect((await grantsOf(connectionId)).map((row) => row.actionId)).not.toContain(actionId);
			}
		});

		test('grants nothing to any other agent, nor on any other connection', async () => {
			expect((await grantsOf('lena-chat')).filter((row) => row.agentId === 'lena-dot')).toEqual([
				{agentId: 'lena-dot', connectionId: 'lena-chat', actionId: 'readThreads', allowed: true},
			]);
			expect((await grantsOf('lena-vault')).map((row) => row.actionId)).toEqual(['readThreads']);
		});

		test('adds nothing run again', async () => {
			await pg.exec(migrationSql(migration));
			expect((await grantsOf('lena-chat')).filter((row) => row.actionId === actionId)).toHaveLength(
				1,
			);
		});
	});
}
