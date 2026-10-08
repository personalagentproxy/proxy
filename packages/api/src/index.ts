import {createServer} from 'node:http';

import {Result} from 'ts-results-es';

import {connectDb, disconnectDb} from '@proxy/db';

import {log, serializeError} from './observability/log';
import {createHttpApp} from './server/create-http-app';
import {startTelemetry} from './telemetry';
import {env} from './utils/env';

let isShuttingDown = false;

void startApiServer();

async function startApiServer(): Promise<void> {
	const server = createServer(createHttpApp());
	const port = Number(env.PORT) || 4000;

	const connectDbResult = await Result.wrapAsync(() => connectDb());
	if (connectDbResult.isErr()) {
		log.error('Failed to connect Prisma to Postgres', serializeError(connectDbResult.error));
		process.exit(1);
	}
	startTelemetry();

	const shutdown = async (signal: string): Promise<void> => {
		if (isShuttingDown) {
			return;
		}
		isShuttingDown = true;
		log.info(`Received ${signal}, shutting down`);

		// If draining hangs, exit anyway rather than hold database connections through the
		// orchestrator's grace period.
		const forceExit = setTimeout(() => {
			console.error('[api] Shutdown timed out, forcing exit');
			process.exit(1);
		}, 10_000);
		forceExit.unref();

		server.close();

		const disconnectResult = await Result.wrapAsync(() => disconnectDb());
		if (disconnectResult.isErr()) {
			log.error('Failed to disconnect Prisma', serializeError(disconnectResult.error));
		}

		process.exit(0);
	};

	process.once('SIGINT', () => {
		void shutdown('SIGINT');
	});
	process.once('SIGTERM', () => {
		void shutdown('SIGTERM');
	});

	server.listen(port, () => {
		log.info(`@proxy/api listening on http://localhost:${port}`);
	});
}
