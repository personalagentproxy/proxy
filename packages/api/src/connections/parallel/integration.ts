import {parallelConnectors} from '../../records/web-connector';
import {builtInMcpIntegration} from '../mcp/mcp-connect';
import {PARALLEL_MCP} from './built-in';

export const PARALLEL_INTEGRATION = builtInMcpIntegration(PARALLEL_MCP, parallelConnectors);
