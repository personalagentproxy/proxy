import {readdirSync} from 'node:fs';

import {expect, test} from 'bun:test';

// Prisma applies migrations in the order their folder names sort as text, not by their number, and
// every database keeps the names it applied, so they can never be renamed. The first ten are
// `0_init` to `9_mcp_oauth`; a `10_x` would sort before `1_connections`. Every migration after them
// is `v` and three digits, from `v010`: letters sort after digits, and the padding keeps the order
// to `v999`.
const LEGACY = /^\d_[a-z0-9_]+$/;
const NAMED = /^v(\d{3})_[a-z0-9_]+$/;

const names = readdirSync(new URL('../prisma/migrations', import.meta.url), {withFileTypes: true})
	.filter((entry) => entry.isDirectory())
	.map((entry) => entry.name);

// A migration's place in line: the legacy ones by their digit, then the `v` ones by their number.
function position(name: string): number | null {
	if (LEGACY.test(name)) {
		return Number(name[0]);
	}
	const numbered = NAMED.exec(name);
	if (numbered?.[1] === undefined) {
		return null;
	}
	return Number(numbered[1]);
}

test('every migration is named v and three digits, such as v010_add_x', () => {
	const misnamed = names.filter((name) => position(name) === null);

	expect(
		misnamed,
		`Name new migrations v<three digits>_<snake_case>, numbered on from the last one, such as v010_add_x`,
	).toEqual([]);
});

test('no two migrations share a number, and every v one comes after the first ten', () => {
	const positions = names.map(position);
	const named = names.filter((name) => NAMED.test(name)).map(position);

	expect(new Set(positions).size).toBe(positions.length);
	expect(named.filter((number) => number !== null && number < 10)).toEqual([]);
});

test('migrations sort as text in the order they are numbered, as Prisma applies them', () => {
	const byText = [...names].sort();
	const byNumber = [...names].sort((a, b) => (position(a) ?? 0) - (position(b) ?? 0));

	expect(byText).toEqual(byNumber);
});
