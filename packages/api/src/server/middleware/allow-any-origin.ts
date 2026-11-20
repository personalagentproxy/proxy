import type {NextFunction, Request, Response} from 'express';

/**
 * CORS for the endpoints called without cookies: the OAuth metadata, registration, the token
 * endpoint and the MCP server, so an MCP client running in a browser, such as the MCP Inspector,
 * can reach them; and an upload's URL, whose secret is its credential, which a page may PUT a
 * file to. Nothing here reads a cookie, so any origin is as safe as none; every other route stays
 * same-origin.
 */
export function allowAnyOrigin(req: Request, res: Response, next: NextFunction): void {
	res.setHeader('Access-Control-Allow-Origin', '*');
	res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
	res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, MCP-Protocol-Version, Mcp-Session-Id');
	res.setHeader('Access-Control-Expose-Headers', 'WWW-Authenticate, Mcp-Session-Id');
	if (req.method === 'OPTIONS') {
		res.status(204).end();
		return;
	}
	next();
}
