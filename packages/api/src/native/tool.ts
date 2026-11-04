import type {Result} from 'ts-results-es';

import type {ApiError} from '@proxy/utils';
import type {ConnectionRow} from '@proxy/db/connection';

import type {TaskCaller} from '../agent-side/tools';

/**
 * How the api runs an integration's own tools (`@proxy/integrations` NativeTool): the
 * integration's module names a runner for each (`connections/integration.ts`), which the gate
 * calls once it has checked the agent has the action the tool needs, and logs by the tool's name
 * with its params, as it does a custom server's tools (`agent-side/tools.ts`). The params are as
 * the agent gave them, an object and nothing more checked: a runner reads them against the tool's
 * own schema. It answers with text, as a custom server's tool does.
 */

/** A run of one of the integration's own tools: who runs it and for which task, on which connection, with what. */
export type NativeToolRun = {caller: TaskCaller; connection: ConnectionRow & {credential: string | null}; params: Record<string, unknown>};

export type NativeToolRunner = (run: NativeToolRun) => Promise<Result<string, ApiError>>;
