import {Err, Ok, type Result} from 'ts-results-es';

import {ApiErr, type ApiError} from '@proxy/utils';
import {buildPap, type PapBundle} from '@proxy/cli/build';

import {log, serializeError} from '../observability/log';

/**
 * The `pap` binary this server installs in sandboxes (@proxy/cli), built from its source the first
 * time a command needs it, which the api can do as it runs under Bun everywhere, and kept for as
 * long as the process lives, with its version. A build that fails is logged and is unavailable
 * to the command, and is tried again by the next.
 */

let built: Promise<Result<PapBundle, Error>> | null = null;

export async function papBundle(): Promise<Result<PapBundle, ApiError>> {
	built ??= buildPap();
	const result = await built;
	if (result.isOk()) {
		return Ok(result.value);
	}
	built = null;
	log.error('Building the pap CLI failed', serializeError(result.error));
	return Err(ApiErr.unavailable('pap could not be installed: this server could not build it. Run the command without pap.'));
}
