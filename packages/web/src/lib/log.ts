import {createClientLogger} from '@proxy/observability/client';

export {serializeError} from '@proxy/observability/client';

/**
 * The web app's log: what goes wrong in the browser, posted to the api in batches, which writes
 * it on with the server's (packages/api/src/observability/client-logs.ts). In development it is
 * written to the console as well.
 */
export const log = createClientLogger({
	endpoint: '/api/client-logs',
	env: import.meta.env.PROD ? 'production' : 'development',
});
