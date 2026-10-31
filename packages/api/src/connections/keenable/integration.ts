import {keenableConnectors} from '../../records/web-connector';
import {builtInMcpIntegration} from '../mcp/mcp-connect';
import {KEENABLE_MCP} from './built-in';

export const KEENABLE_INTEGRATION = builtInMcpIntegration(KEENABLE_MCP, keenableConnectors);
