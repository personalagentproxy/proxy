// What keeps password managers off a field that takes an address, a secret or a search that is
// not the person's own login: a mailbox's address and app password, a database user, an API key,
// an invitation's address, the quick-action input. Browsers heed `autoComplete`; the password
// managers each have a mark of their own and ignore it: Bitwarden, 1Password, LastPass and
// Dashlane, in that order. Spread onto the input.
export const NO_PASSWORD_MANAGER = {
	autoComplete: 'off',
	'data-bwignore': true,
	'data-1p-ignore': true,
	'data-lpignore': 'true',
	'data-form-type': 'other',
} as const;
