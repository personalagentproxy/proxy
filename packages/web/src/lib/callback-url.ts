// Only same-site paths: `/foo` is fine; `//evil.com`, `https://evil.com`, `javascript:` and
// backslash variants (`/\evil.com`) that some browsers normalize to `//` are not.
export function sanitizeCallbackUrl(raw: string | null): string | undefined {
	if (!raw) {
		return undefined;
	}
	if (!raw.startsWith('/')) {
		return undefined;
	}
	if (raw.startsWith('//') || raw.startsWith('/\\')) {
		return undefined;
	}
	return raw;
}
