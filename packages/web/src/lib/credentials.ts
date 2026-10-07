// No 0/O or 1/l/I, so a password read off the screen is typed right the first time.
const ALPHABET = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function randomChars(length: number): string {
	const bytes = crypto.getRandomValues(new Uint8Array(length));
	return Array.from(bytes, (byte) => ALPHABET[byte % ALPHABET.length]).join('');
}

export function newId(): string {
	return crypto.randomUUID().slice(0, 8);
}

// "Grok Bot" → "grok-bot-k7q2": the provider keeps logins recognizable and the suffix
// prevents collisions with credentials created before a provider was deleted and added again.
export function generateUsername(name: string): string {
	const slug = name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-|-$/g, '');
	const suffix = randomChars(4).toLowerCase();
	if (slug.length === 0) {
		return `agent-${suffix}`;
	}

	return `${slug}-${suffix}`;
}

// Four groups of five, about 115 bits.
export function generatePassword(): string {
	return [randomChars(5), randomChars(5), randomChars(5), randomChars(5)].join('-');
}
