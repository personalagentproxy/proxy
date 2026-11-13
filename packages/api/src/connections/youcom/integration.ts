import {youcomConnectors} from '../../records/web-connector';
import {builtInMcpIntegration} from '../mcp/mcp-connect';
import {YOUCOM_MCP} from './built-in';

export const YOUCOM_INTEGRATION = builtInMcpIntegration(YOUCOM_MCP, youcomConnectors);
