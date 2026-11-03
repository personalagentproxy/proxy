import {linearConnector} from '../../records/linear-connector';
import {builtInMcpIntegration} from '../mcp/mcp-connect';
import {LINEAR_MCP} from './built-in';

export const LINEAR_INTEGRATION = builtInMcpIntegration(LINEAR_MCP, {issues: linearConnector});
