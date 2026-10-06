import {Result} from 'ts-results-es';

// The human side's session cookie. The `__Secure-` prefix makes browsers refuse it over plain
// HTTP, so it is only used where cookies are secure, in production.
export const sessionCookieNames = {
	secure: '__Secure-proxy.session-token',
	insecure: 'proxy.session-token',
} as const;

// The agent side's, apart from the human's, so one browser can be signed in as both.
export const agentSessionCookieNames = {
	secure: '__Secure-proxy.agent-session',
	insecure: 'proxy.agent-session',
} as const;

function readCookie(
	cookieHeader: string | undefined,
	names: {secure: string; insecure: string},
): string | null {
	if (!cookieHeader) {
		return null;
	}

	const cookies = parseCookieHeader(cookieHeader);
	return cookies.get(names.secure) || cookies.get(names.insecure) || null;
}

export function getSessionTokenFromHeader(cookieHeader: string | undefined): string | null {
	return readCookie(cookieHeader, sessionCookieNames);
}

export function getAgentSessionTokenFromHeader(cookieHeader: string | undefined): string | null {
	return readCookie(cookieHeader, agentSessionCookieNames);
}

export function parseCookieHeader(header: string): Map<string, string> {
	const cookies = new Map<string, string>();

	for (const part of header.split(';')) {
		const trimmed = part.trim();
		if (!trimmed) {
			continue;
		}

		const separatorIndex = trimmed.indexOf('=');
		if (separatorIndex === -1) {
			continue;
		}

		const name = trimmed.slice(0, separatorIndex).trim();
		const rawValue = trimmed.slice(separatorIndex + 1);
		cookies.set(name, decodeCookieValue(rawValue));
	}

	return cookies;
}

function decodeCookieValue(value: string): string {
	return Result.wrap(() => decodeURIComponent(value)).unwrapOr(value);
}
