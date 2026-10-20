import {textParam, type BuiltInMcp} from '../mcp/built-in';
import {getNotionAccount, NOTION} from './notion-mcp';

/**
 * Notion, through its MCP server, as Granola is. A new Notion connection lets agents read its pages
 * by default; creating and editing are turned on on the connection's page.
 */
export const NOTION_MCP: BuiltInMcp = {
	integrationId: 'notion',
	server: NOTION,
	account: getNotionAccount,
	defaults: ['read'],
	tools: {
		'notion-search': {actions: ['read'], run: (params) => ({collectionId: 'pages', operation: 'list', query: textParam(params, 'query')})},
		'notion-fetch': {actions: ['read'], run: () => ({collectionId: 'pages', operation: 'view'})},
		'notion-create-pages': {actions: ['create'], run: () => ({collectionId: 'pages', operation: 'create'})},
		'notion-update-page': {actions: ['edit'], run: () => ({collectionId: 'pages', operation: 'update'})},
	},
};
