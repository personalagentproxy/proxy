import type {ApiIntegration} from '../../connections/integration';
import {sandboxConnector} from './connector';
import {runSandboxCommand} from './exec';

/** Sandboxes, in Personal Agent Proxy itself: the sandboxes as records, and the console as its own tool. */
export const SANDBOX_INTEGRATION: ApiIntegration = {
	id: 'sandbox',
	connectors: {sandboxes: sandboxConnector},
	tools: {sandbox_exec: runSandboxCommand},
};
