// Every package's tests against a database of their own: Prisma's embedded Postgres, in memory,
// started next to the local database's ports, with migrations applied, and gone once they end.
// The tests that write to the database run, which `bun run test` skips without DATABASE_URL, and
// nothing else is at work in it: a running `bun run dev` claims jobs, alerts and polls from the
// database it uses as they come due, which would take those the tests queue, and keeps what they
// leave out of its data. Run from the repository's root as `bun run test:db`.
import {spawn} from 'node:child_process';
import {once} from 'node:events';

import {startPrismaDevServer} from '@prisma/dev';
import {Result} from 'ts-results-es';

// Past the local database's own ports, its shadow's and its streams', so both run at once.
const OFFSET = 10;

const raw = process.env.DATABASE_URL;
if (!raw || !URL.canParse(raw)) {
	console.error('[test-db] DATABASE_URL is missing or invalid; see .env.example.');
	process.exit(1);
}

// The local database's URL, its port moved: the same credentials and parameters reach this one.
const url = new URL(raw);
const databasePort = Number(url.port) + OFFSET;
url.port = String(databasePort);
const databaseUrl = url.toString();

const started = await Result.wrapAsync(() =>
	startPrismaDevServer({
		name: 'proxy-test',
		persistenceMode: 'stateless',
		port: databasePort - 1,
		databasePort,
		shadowDatabasePort: databasePort + 1,
		streamsPort: databasePort + 2,
	}),
);
if (started.isErr()) {
	console.error('[test-db] Failed to start the test database:', started.error);
	process.exit(1);
}
const server = started.value;

// Runs a command to its end with the test database's URL; answers its exit code.
async function run(command: string[], cwd: string): Promise<number> {
	const [program = 'bun', ...args] = command;
	const child = spawn(program, args, {
		cwd,
		stdio: 'inherit',
		env: {...process.env, DATABASE_URL: databaseUrl, PRISMA_HIDE_UPDATE_MESSAGE: '1'},
	});
	const [code] = await once(child, 'exit');
	return typeof code === 'number' ? code : 1;
}

const root = new URL('../../../', import.meta.url).pathname;
const migrated = await run(
	['bunx', 'prisma', 'migrate', 'deploy'],
	new URL('../', import.meta.url).pathname,
);
const code = migrated === 0 ? await run(['bun', 'run', 'test'], root) : migrated;
await server.close();
process.exit(code);
