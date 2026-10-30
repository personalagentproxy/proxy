import {exaConnectors} from '../../records/web-connector';
import {builtInMcpIntegration} from '../mcp/mcp-connect';
import {EXA_MCP} from './built-in';

export const EXA_INTEGRATION = builtInMcpIntegration(EXA_MCP, exaConnectors);
