import type {Response} from 'express';

/** An OAuth error as RFC 6749 writes it: `{error, error_description}` with its status. */
export type OAuthError = {status: number; error: string; description: string};

export function sendOAuthError(res: Response, error: OAuthError): void {
	res.status(error.status).setHeader('Cache-Control', 'no-store').json({error: error.error, error_description: error.description});
}
