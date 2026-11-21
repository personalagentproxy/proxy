import type {ApiIntegration} from '../../connections/integration';
import {memoryConnector} from './connector';
import {runMemoryForget, runMemoryWrite} from './tools';

/** Memory, in Personal Agent Proxy itself: a member's notes as records, read, and every write a tool of its own. */
export const MEMORY_INTEGRATION: ApiIntegration = {
	id: 'memory',
	connectors: {notes: memoryConnector},
	tools: {memory_write: runMemoryWrite, memory_forget: runMemoryForget},
};
