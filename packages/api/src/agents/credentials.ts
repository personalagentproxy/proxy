import {randomInt} from 'node:crypto';

// No 0/O or 1/l/I, so a password read off the screen is typed right the first time.
const ALPHABET = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function randomChars(length: number): string {
	return Array.from({length}, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
}

// "Shopping agent" → "shopping-agent-k7q2": the name keeps logins told apart in the audit log,
// the suffix keeps two agents of the same name apart.
export function generateUsername(name: string): string {
	const slug = name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-|-$/g, '')
		.slice(0, 40);
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
