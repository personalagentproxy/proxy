import {readdirSync, readFileSync} from 'node:fs';

import {PGlite} from '@electric-sql/pglite';
import {afterAll, beforeAll, describe, expect, test} from 'bun:test';

import {DEFAULT_LOOK} from '@proxy/utils/harness';

// The migration that gives every shared persona nobody made its organization's owner for a maker,
// and General to every organization with no persona at all (v077), run on rows as they were: a
// database of its own, in this process, which PGlite keeps in memory, made with every migration
// before it, as reshape-chats-migration.test.ts makes one. Nothing here needs the local database.
const MIGRATION = 'v077_make_general_the_owners';

const migrations = new URL('../prisma/migrations/', import.meta.url);

function migrationSql(name: string): string {
	return readFileSync(new URL(`${name}/migration.sql`, migrations), 'utf8');
}

// Prisma applies the migrations in the order their names sort as text (migrations.test.ts).
const before = readdirSync(migrations, {withFileTypes: true})
	.filter((entry) => entry.isDirectory() && entry.name < MIGRATION)
	.map((entry) => entry.name)
	.sort();

type Value = string | null;

const pg = new PGlite();

async function insert(table: string, row: Record<string, Value>): Promise<void> {
	const columns = Object.keys(row);
	await pg.query(
		`INSERT INTO "${table}" (${columns.map((column) => `"${column}"`).join(', ')}) VALUES (${columns.map((_, index) => `$${index + 1}`).join(', ')})`,
		Object.values(row),
	);
}

type PersonaRow = {
	id: string;
	name: string;
	look: string;
	color: string;
	ownerUserId: string | null;
	createdById: string | null;
	harness: string;
	chatModel: string;
};

// An organization's personas by id: those made within a millisecond of each other have no order
// by when they were made.
async function personasOf(orgId: string): Promise<PersonaRow[]> {
	return (
		await pg.query<PersonaRow>(
			`SELECT "id", "name", "look", "color", "ownerUserId", "createdById", "harness", "chatModel" FROM "Persona" WHERE "orgId" = $1 ORDER BY "id"`,
			[orgId],
		)
	).rows;
}

async function org(id: string, ownerUserId: string): Promise<void> {
	await insert('Organization', {id, name: id, slug: id, ownerUserId});
	await insert('OrgMember', {id: `${id}-${ownerUserId}`, orgId: id, userId: ownerUserId});
}

async function persona(
	id: string,
	orgId: string,
	fields: {ownerUserId: string | null; createdById: string | null},
): Promise<void> {
	await insert('Persona', {id, orgId, name: id, look: '{}', color: 'green', ...fields});
}

// Four organizations, as the migration finds them: Harbor, whose General was made on a first
// listing of Chat by nobody, beside a shared one Omar made and one of his own; Orchard, whose
// shared Scout was made by a member who has since left; Meadow, whose members never opened Chat;
// and Quarry, with only a persona of Ivo's own.
async function seed(): Promise<void> {
	for (const id of ['lena', 'omar', 'ruth', 'gone', 'ivo', 'pia']) {
		await insert('User', {id, email: `${id}@example.com`});
	}
	await org('harbor', 'lena');
	await insert('OrgMember', {id: 'harbor-omar', orgId: 'harbor', userId: 'omar'});
	await persona('harbor-general', 'harbor', {ownerUserId: null, createdById: null});
	await persona('harbor-research', 'harbor', {ownerUserId: null, createdById: 'omar'});
	await persona('harbor-omar', 'harbor', {ownerUserId: 'omar', createdById: 'omar'});

	await org('orchard', 'ruth');
	await persona('orchard-scout', 'orchard', {ownerUserId: null, createdById: 'gone'});

	await org('meadow', 'pia');

	await org('quarry', 'ivo');
	await persona('quarry-ivo', 'quarry', {ownerUserId: 'ivo', createdById: 'ivo'});
}

beforeAll(async () => {
	for (const name of before) {
		await pg.exec(migrationSql(name));
	}
	await seed();
	await pg.exec(migrationSql(MIGRATION));
});

afterAll(async () => {
	await pg.close();
});

describe(MIGRATION, () => {
	test('a shared persona nobody made is its organization’s owner’s making, and every other keeps its maker', async () => {
		expect(
			(await personasOf('harbor')).map(({id, ownerUserId, createdById}) => ({
				id,
				ownerUserId,
				createdById,
			})),
		).toEqual([
			{id: 'harbor-general', ownerUserId: null, createdById: 'lena'},
			{id: 'harbor-omar', ownerUserId: 'omar', createdById: 'omar'},
			{id: 'harbor-research', ownerUserId: null, createdById: 'omar'},
		]);
	});

	test('a shared persona whose maker left keeps them, and stays everyone’s', async () => {
		expect(
			(await personasOf('orchard')).map(({id, ownerUserId, createdById}) => ({
				id,
				ownerUserId,
				createdById,
			})),
		).toEqual([{id: 'orchard-scout', ownerUserId: null, createdById: 'gone'}]);
	});

	test('an organization with no persona gets General, shared, made by its owner, with the first look in blue', async () => {
		const [general, ...more] = await personasOf('meadow');
		expect(more).toEqual([]);
		expect(general).toMatchObject({
			name: 'General',
			color: 'blue',
			ownerUserId: null,
			createdById: 'pia',
			harness: 'claude-agent-sdk',
			chatModel: 'sonnet',
		});
		expect(general?.look).toBe(JSON.stringify(DEFAULT_LOOK));
	});

	test('an organization with personas but none shared is left as it is', async () => {
		expect((await personasOf('quarry')).map(({id}) => id)).toEqual(['quarry-ivo']);
	});
});
