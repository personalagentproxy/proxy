import {notionConnector} from '../../records/notion-connector';
import {builtInMcpIntegration} from '../mcp/mcp-connect';
import {NOTION_MCP} from './built-in';

export const NOTION_INTEGRATION = builtInMcpIntegration(NOTION_MCP, {pages: notionConnector});
