import {setDbLogger} from '@proxy/utils';
import {createServerLogger, type Logger} from '@proxy/observability/server';

import {envLabel, lokiConfig} from './config';
import {getContext} from './request-context';

export type {Logger};
export {serializeError} from '@proxy/observability';

/**
 * The api's logger: stdout always, and a Loki when LOKI_URL is set (config.ts). Every
 * line carries the request or job it was written in (request-context.ts).
 */
export const log: Logger = createServerLogger({
	loki: lokiConfig,
	service: 'api',
	env: envLabel,
	getAmbientContext: getContext,
});

setDbLogger(log.child({source: 'db'}));
