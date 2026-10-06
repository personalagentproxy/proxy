// The local database: Prisma's embedded Postgres (PGlite), started on the port in DATABASE_URL,
// with migrations applied. Runs until stopped; the data survives restarts.
import {spawn} from 'node:child_process';
import {once} from 'node:events';

import {startPrismaDevServer} from '@prisma/dev';
import {Result} from 'ts-results-es';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);

const raw = process.env.DATABASE_URL;
if (!raw || !URL.canParse(raw)) {
	console.error('[db] DATABASE_URL is missing or invalid; see .env.example.');
	process.exit(1);
}

const url = new URL(raw);
if (!LOCAL_HOSTS.has(url.hostname)) {
	console.error(`[db] DATABASE_URL points at ${url.hostname}, not the local database.`);
	process.exit(1);
}

// The server keeps prepared statements across connections, which collide between processes and
// pooled connections unless Prisma skips them (pgbouncer) and holds one connection.
if (
	url.searchParams.get('pgbouncer') !== 'true' ||
	url.searchParams.get('connection_limit') !== '1'
) {
	console.error(
		'[db] DATABASE_URL needs connection_limit=1&pgbouncer=true for the local database.',
	);
	process.exit(1);
}

// The other ports sit next to the database's so one URL places them all.
const databasePort = Number(url.port);
const started = await Result.wrapAsync(() =>
	startPrismaDevServer({
		name: 'proxy',
		persistenceMode: 'stateful',
		port: databasePort - 1,
		databasePort,
		shadowDatabasePort: databasePort + 1,
		streamsPort: databasePort + 2,
	}),
);
if (started.isErr()) {
	console.error('[db] Failed to start the local database:', started.error);
	process.exit(1);
}

const server = started.value;

// Async on purpose: the database runs in this process, so blocking it would leave the migration
// waiting on a server that can't answer.
const migrate = spawn('bunx', ['prisma', 'migrate', 'deploy'], {
	stdio: 'inherit',
	env: {...process.env, PRISMA_HIDE_UPDATE_MESSAGE: '1'},
});
const [exitCode] = await once(migrate, 'exit');
if (exitCode !== 0) {
	await server.close();
	process.exit(1);
}

console.log(`[db] Database ready on port ${databasePort}`);

async function shutdown(): Promise<void> {
	await server.close();
	process.exit(0);
}

process.once('SIGINT', () => {
	void shutdown();
});
process.once('SIGTERM', () => {
	void shutdown();
});
