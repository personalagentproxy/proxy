import type {NextFunction, Request, Response} from 'express';

/**
 * CORS for the endpoints MCP clients call without cookies: the OAuth metadata, registration, the
 * token endpoint and the MCP server, so a client running in a browser, such as the MCP Inspector,
 * can reach them. Nothing here reads a cookie, so any origin is as safe as none; every other
 * route stays same-origin.
 */
export function allowAnyOrigin(req: Request, res: Response, next: NextFunction): void {
	res.setHeader('Access-Control-Allow-Origin', '*');
	res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
	res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, MCP-Protocol-Version, Mcp-Session-Id');
	res.setHeader('Access-Control-Expose-Headers', 'WWW-Authenticate, Mcp-Session-Id');
	if (req.method === 'OPTIONS') {
		res.status(204).end();
		return;
	}
	next();
}
