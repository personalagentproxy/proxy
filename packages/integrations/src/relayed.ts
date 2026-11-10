/**
 * What the activity log names as the collection of a request relayed to a provider as it is, which
 * has none: code in a sandbox using git, or the provider's own API, through Personal Agent Proxy
 * with the connection's token, as `pap git` and `pap gh` do for GitHub. The entry's action is the
 * integration's action the request needed, its record title the repository it named, where it named
 * one, and its query what was done: a push's refs, or an API request's method and path.
 */

/** A git request: a fetch, or a push. */
export const GIT_REQUESTS_ID = 'git';

/** A request of the provider's API, by its method and path. */
export const API_REQUESTS_ID = 'api';
