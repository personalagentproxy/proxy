import {readdirSync} from 'node:fs';

import {expect, test} from 'bun:test';

// Prisma applies migrations in the order their folder names sort as text, not by their number:
// `10_x` would run before `1_x` and `9_x`, on a database that has neither yet. So the names have
// to sort in the order the migrations were made.
test('migrations sort as text in the order they are numbered', () => {
	const names = readdirSync(new URL('../prisma/migrations', import.meta.url), {withFileTypes: true})
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name);
	const byText = [...names].sort();
	const byNumber = [...names].sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10));

	expect(byText).toEqual(byNumber);
});
