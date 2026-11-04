import type {Result} from 'ts-results-es';

import {type ApiError, Do, parseSchema} from '@proxy/utils';
import {clientLogBatchSchema, type ServiceLabel} from '@proxy/observability';
import {createServerLogger, type Logger} from '@proxy/observability/server';

import type {AuthenticatedRequest} from '../server/middleware/require-auth';
import {envLabel, lokiConfig} from './config';
import {getContext} from './request-context';

/**
 * The web app's log lines, posted in batches (the package's client.ts) and written on as the web
 * app's or the desktop app's, which adds its name to its user agent, with the request's scope,
 * so the person is on them. A line's own time is kept as `clientTs`; Loki's is the server's.
 */

const DESKTOP_USER_AGENT = 'PersonalAgentProxyDesktop/';

// A device's clock may be off; one off by more than a week would mislead any query by time.
const MAX_CLIENT_SKEW_MS = 7 * 24 * 60 * 60 * 1000;

function forwarder(service: ServiceLabel): Logger {
	return createServerLogger({
		loki: lokiConfig,
		service,
		env: envLabel,
		// The web app keeps its own lines down; what it sends is worth the server's log.
		minLevel: 'debug',
		getAmbientContext: getContext,
	});
}

// The web app in a browser, or in the desktop app's window.
type ClientService = Extract<ServiceLabel, 'web' | 'desktop'>;

const forwarders: Record<ClientService, Logger> = {
	web: forwarder('web'),
	desktop: forwarder('desktop'),
};

function serviceOf(userAgent: string): ClientService {
	return userAgent.includes(DESKTOP_USER_AGENT) ? 'desktop' : 'web';
}

function clientTs(ts: number, now: number): number {
	return Math.abs(ts - now) > MAX_CLIENT_SKEW_MS ? now : ts;
}

export function handleClientLogsRoute(req: AuthenticatedRequest): Promise<Result<void, ApiError>> {
	return Do(async ($) => {
		const {entries} = $(parseSchema(clientLogBatchSchema, req.body));
		const userAgent = req.get('user-agent') ?? '';
		const log = forwarders[serviceOf(userAgent)];
		const now = Date.now();
		for (const entry of entries) {
			log[entry.level](entry.msg, {...entry.ctx, clientTs: clientTs(entry.ts, now), userAgent});
		}
	});
}
