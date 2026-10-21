import {named, type BuiltInMcp} from '../mcp/built-in';
import {GRANOLA, getGranolaAccount} from './granola-mcp';

/**
 * Granola, through its MCP server. A new Granola connection lets agents read both its notes and
 * its transcripts by default; either can be turned off on the connection's page.
 */
export const GRANOLA_MCP: BuiltInMcp = {
	integrationId: 'granola',
	server: GRANOLA,
	account: named(getGranolaAccount),
	defaults: ['readNotes', 'readTranscripts'],
	tools: {
		list_meetings: {actions: ['readNotes'], run: () => ({collectionId: 'notes', operation: 'list'})},
		get_meetings: {actions: ['readNotes'], run: () => ({collectionId: 'notes', operation: 'view'})},
		get_meeting_transcript: {actions: ['readTranscripts'], run: () => ({collectionId: 'transcripts', operation: 'view'})},
	},
};
