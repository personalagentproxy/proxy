/**
 * Trims, rejects multiple `@`s and quoted locals, lowercases, drops everything after the first
 * comma in the domain, and requires a dot in the domain. Null for anything else.
 */
export function normalizeEmail(raw: string): string | null {
	const trimmed = raw.trim();
	const atCount = (trimmed.match(/@/g) ?? []).length;
	if (atCount !== 1) {
		return null;
	}

	if (trimmed.includes('"')) {
		return null;
	}

	const [local, domainRaw] = trimmed.toLowerCase().split('@');
	if (!local || !domainRaw) {
		return null;
	}

	const domain = domainRaw.split(',')[0];
	if (!domain || !domain.includes('.')) {
		return null;
	}

	return `${local}@${domain}`;
}
