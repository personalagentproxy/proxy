import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {afterAll, beforeAll, expect, test} from 'bun:test';

const pg = new PGlite();

beforeAll(async () => {
	await pg.exec(`
		CREATE TABLE "Persona" ("id" TEXT PRIMARY KEY, "ownerUserId" TEXT);
		CREATE TABLE "AgentAlert" ("id" TEXT PRIMARY KEY, "userId" TEXT NOT NULL);
		CREATE TABLE "AgentThread" ("id" TEXT PRIMARY KEY, "personaId" TEXT, "userId" TEXT NOT NULL);
		CREATE TABLE "AgentEntry" ("id" TEXT PRIMARY KEY, "text" TEXT NOT NULL);
		INSERT INTO "Persona" VALUES ('general', NULL), ('personal', 'member-a');
		INSERT INTO "AgentEntry" VALUES ('old-message', 'Private historical message');
	`);
	await pg.exec(
		readFileSync(
			new URL('../prisma/migrations/v067_team_chat_scope/migration.sql', import.meta.url),
			'utf8',
		),
	);
});

afterAll(async () => {
	await pg.close();
});

test('existing shared configurations retain separate member histories', async () => {
	const result = await pg.query<{id: string; conversationScope: string; headAgent: boolean}>(
		'SELECT "id", "conversationScope", "headAgent" FROM "Persona" ORDER BY "id"',
	);
	expect(result.rows).toEqual([
		{id: 'general', conversationScope: 'member', headAgent: false},
		{id: 'personal', conversationScope: 'member', headAgent: false},
	]);
	const messages = await pg.query('SELECT * FROM "AgentEntry"');
	expect(messages.rows).toEqual([
		{id: 'old-message', text: 'Private historical message', senderUserId: null, senderName: null},
	]);
});

test('a scope edit cannot publish existing conversations', async () => {
	await expect(
		pg.exec(`UPDATE "Persona" SET "conversationScope" = 'team' WHERE "id" = 'general'`),
	).rejects.toThrow('Conversation scope is immutable');
});

test('team conversations must be organization-visible when created', async () => {
	await expect(
		pg.exec(
			`INSERT INTO "Persona" ("id", "ownerUserId", "conversationScope") VALUES ('invalid-team', 'member-a', 'team')`,
		),
	).rejects.toThrow();
	await pg.exec(
		`INSERT INTO "Persona" ("id", "conversationScope", "headAgent") VALUES ('team', 'team', true)`,
	);
	const result = await pg.query(
		'SELECT "ownerUserId", "conversationScope", "headAgent" FROM "Persona" WHERE "id" = $1',
		['team'],
	);
	expect(result.rows).toEqual([{ownerUserId: null, conversationScope: 'team', headAgent: true}]);
});

test('shared execution cannot carry a private member identity', async () => {
	await expect(
		pg.exec(
			`INSERT INTO "AgentThread" ("id", "userId", "teamChat") VALUES ('unsafe', 'member-a', true)`,
		),
	).rejects.toThrow();
	await pg.exec(
		`INSERT INTO "AgentThread" ("id", "userId", "teamChat") VALUES ('safe', NULL, true)`,
	);
});
