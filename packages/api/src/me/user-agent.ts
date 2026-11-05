/**
 * What the account page says a session is, from the User-Agent it signed in with: the browser,
 * or the desktop app (Electron's header names Chrome too, so it is checked first), and the system.
 * Each is null when the header names none we know. In the order that tells them apart: Edge and
 * Opera name Chrome, Chrome names Safari, and iOS names Mac OS X.
 */
export function describeUserAgent(userAgent: string | null): {client: string | null; os: string | null} {
	if (!userAgent) {
		return {client: null, os: null};
	}

	return {client: clientOf(userAgent), os: osOf(userAgent)};
}

function clientOf(userAgent: string): string | null {
	if (/\bElectron\//.test(userAgent)) {
		return 'Desktop app';
	}

	if (/\bEdg(e|A|iOS)?\//.test(userAgent)) {
		return 'Edge';
	}

	if (/\b(OPR|Opera)\//.test(userAgent)) {
		return 'Opera';
	}

	if (/\b(Firefox|FxiOS)\//.test(userAgent)) {
		return 'Firefox';
	}

	if (/\b(Chrome|CriOS)\//.test(userAgent)) {
		return 'Chrome';
	}

	if (/\bSafari\//.test(userAgent)) {
		return 'Safari';
	}

	return null;
}

function osOf(userAgent: string): string | null {
	if (/\b(iPhone|iPad|iPod)\b/.test(userAgent)) {
		return 'iOS';
	}

	if (/\bAndroid\b/.test(userAgent)) {
		return 'Android';
	}

	if (/\bMac OS X\b|\bMacintosh\b/.test(userAgent)) {
		return 'macOS';
	}

	if (/\bWindows\b/.test(userAgent)) {
		return 'Windows';
	}

	if (/\bCrOS\b/.test(userAgent)) {
		return 'ChromeOS';
	}

	if (/\bLinux\b/.test(userAgent)) {
		return 'Linux';
	}

	return null;
}
