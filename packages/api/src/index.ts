import {createServer} from 'node:http';

import {Result} from 'ts-results-es';

import {connectDb, disconnectDb} from '@proxy/db';

import {serverHarnesses} from './backends/registry';
import {runDataMigrations} from './data-migrations/run';
import {harnessStore} from './harness/store';
import {startAlertSweeper, type AlertSweeper} from './harness/alert-sweep';
import {startHarnessWorker, type HarnessWorker} from './harness/worker';
import {claudeCredentialFor, markClaudeCredentialRefused, recordClaudeUsage} from './me/claude-credential';
import {chatFiles} from './native/files/chat';
import {startFilesSweeper} from './native/files/sweeper';
import {startSandboxSweeper} from './native/sandbox/sweeper';
import {log, serializeError} from './observability/log';
import {metrics} from './observability/metrics';
import {startProbes} from './observability/probes';
import {createHttpApp} from './server/create-http-app';
import {startTelemetry} from './telemetry';
import {env} from './utils/env';

let isShuttingDown = false;

void startApiServer();

async function startApiServer(): Promise<void> {
	const server = createServer(createHttpApp());
	// No deadline on receiving a whole request: a push relayed to GitHub from a sandbox
	// (cli/github) streams its pack for as long as it takes. Node's default is five minutes, which
	// Bun reports but doesn't enforce; the deadline on a request's headers stays.
	server.requestTimeout = 0;
	const port = Number(env.PORT) || 4000;

	const connectDbResult = await Result.wrapAsync(() => connectDb());
	if (connectDbResult.isErr()) {
		log.error('Failed to connect Prisma to Postgres', serializeError(connectDbResult.error));
		await log.shutdown();
		process.exit(1);
	}
	startTelemetry();
	startProbes();
	let worker: HarnessWorker | null = null;
	let sweeper: AlertSweeper | null = null;

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
		// The built-in agent's worker claims nothing more and finishes the job it is on; a job it
		// can't finish in time goes to another instance when its lease runs out. The alerts' sweep
		// takes no more; a turn cut short writes nothing, and comes again in ten minutes.
		sweeper?.stop();
		await worker?.stop();

		const disconnectResult = await Result.wrapAsync(() => disconnectDb());
		if (disconnectResult.isErr()) {
			log.error('Failed to disconnect Prisma', serializeError(disconnectResult.error));
		}

		await Promise.all([metrics.shutdown(), log.shutdown()]);
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
		// After listening, since signing in to a provider to name an account can take a while.
		void runDataMigrations();
		// The built-in agent's worker, on the harnesses this server has (backends/registry.ts).
		worker = startHarnessWorker(harnessStore, {
			registry: serverHarnesses(),
			credentials: {claudeCredentialFor, markRefused: markClaudeCredentialRefused, recordUsage: recordClaudeUsage},
			picture: chatFiles.picture,
		});
		sweeper = startAlertSweeper(harnessStore);
		void startSandboxSweeper();
		void startFilesSweeper();
	});
}
