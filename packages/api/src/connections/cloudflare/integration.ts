import {cloudflareDocsConnector, cloudflareEndpointsConnector, cloudflareRequestsConnector} from '../../records/cloudflare-connector';
import {builtInMcpIntegration} from '../mcp/mcp-connect';
import {CLOUDFLARE_MCP} from './built-in';

export const CLOUDFLARE_INTEGRATION = builtInMcpIntegration(CLOUDFLARE_MCP, {requests: cloudflareRequestsConnector, endpoints: cloudflareEndpointsConnector, docs: cloudflareDocsConnector});
