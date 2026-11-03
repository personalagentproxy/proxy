import {granolaNotesConnector, granolaTranscriptsConnector} from '../../records/granola-connector';
import {builtInMcpIntegration} from '../mcp/mcp-connect';
import {GRANOLA_MCP} from './built-in';

export const GRANOLA_INTEGRATION = builtInMcpIntegration(GRANOLA_MCP, {notes: granolaNotesConnector, transcripts: granolaTranscriptsConnector});
