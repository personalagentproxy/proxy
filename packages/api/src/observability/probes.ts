import {db} from '@proxy/db';
import {startDbPoolProbe, startJobQueueProbe} from '@proxy/observability';

import {metrics} from './metrics';

/**
 * What the api measures on its own, once the database is connected: how long a connection of the
 * pool takes to get, every second, and the built-in agent's job queue, every ten. Nothing runs
 * without an address to push metrics to.
 */
export function startProbes(): void {
	if (!metrics.enabled) {
		return;
	}
	startDbPoolProbe({db, metrics});
	startJobQueueProbe({db, metrics});
}
