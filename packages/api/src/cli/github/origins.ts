/**
 * Where GitHub's requests are relayed to (route.ts): its git server and its API. Only ever these,
 * every upstream URL built on one and checked to still be on it (requests.ts); tests put fakes of
 * their own here.
 */
export const GITHUB_ORIGINS = {git: 'https://github.com', api: 'https://api.github.com'};
