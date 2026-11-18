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

/**
 * A run of one of the integration's own tools: who runs it and for which task, on which connection,
 * with what; and the activity log's entry it is logged as, by the id the gate gave it, for what
 * keeps pointing at the run, as an upload does. None where a runner is called outside the gate.
 */
export type NativeToolRun = {caller: TaskCaller; connection: ConnectionRow & {credential: string | null}; params: Record<string, unknown>; entryId?: string};

export type NativeToolRunner = (run: NativeToolRun) => Promise<Result<string, ApiError>>;

/**
 * Whether a run of one of the integration's own tools is one the person allowed by what they did,
 * whatever the agent may do with the connection otherwise: asked by the gate where the agent
 * lacks the action the tool needs, before it refuses, of the integration's module that names one
 * for the tool. As attaching a file in a thread lets its agent read the version attached
 * (native/files/attached.ts). The run is logged as any allowed one is.
 */
export type NativeToolAllowance = (run: NativeToolRun) => Promise<Result<boolean, ApiError>>;

/**
 * The action a run of one of the integration's own tools needs, where it depends on what the run is
 * given rather than being the tool's own: an upload over a file that is there needs Edit files,
 * where a new one needs Add files. Asked by the gate, of the integration's module that names one
 * for the tool, in place of the tool's action.
 */
export type NativeToolAction = (run: NativeToolRun) => Promise<Result<string, ApiError>>;
