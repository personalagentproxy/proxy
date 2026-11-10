/**
 * The CLI's GitHub routes (`/api/cli/github/…`), for `pap git` and `pap gh` in a sandbox: GitHub's
 * own git and API requests, relayed to GitHub by Personal Agent Proxy with the connection's token,
 * which never enters the sandbox, each checked against what the agent is allowed with the
 * connection and written to the activity log. Every request sends `Authorization: Bearer
 * $PAP_TOKEN`, as `/api/cli/call` does, and may name the GitHub connection in
 * `PAP_CONNECTION_HEADER`; without it, the agent's only GitHub connection it can use is the one, and
 * with several, the request is refused with their ids, saying to name one. Without zod, so the
 * `pap` binary can import it.
 *
 * - `GET CLI_GITHUB_IDENTITY_PATH`: `GitHubIdentity`, who commits are made as. Needs Read.
 * - `CLI_GITHUB_GIT_PATH/<owner>/<repo>[.git]/…`: git's smart HTTP, relayed to
 *   `https://github.com/<owner>/<repo>.git/…`: `GET info/refs?service=git-upload-pack` and
 *   `POST git-upload-pack` need Read, `GET info/refs?service=git-receive-pack` and
 *   `POST git-receive-pack` need Push. Nothing else, Git LFS among it. A refusal is a git `ERR`
 *   packet, which git prints as `fatal: remote error: <message>`. Run the real git with, for this
 *   invocation alone (`GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_<n>`, `GIT_CONFIG_VALUE_<n>`):
 *   `url.<PAP_URL>/api/cli/github/git/.insteadOf=https://github.com/` (and `git@github.com:` and
 *   `ssh://git@github.com/`, which `pap git` adds too) and
 *   `http.<PAP_URL>/api/cli/github/git/.extraHeader=Authorization: Bearer <PAP_TOKEN>`, and
 *   `http.<…>.extraHeader=x-pap-connection: <id>` to name a connection.
 * - `CLI_GITHUB_API_PATH/<path>`: GitHub's REST and GraphQL API, relayed to
 *   `https://api.github.com/<path>` with its query, any method. `GET` and `HEAD` need Read;
 *   `POST graphql` needs Read for a query and Write for a mutation; anything else needs Write.
 *   Redirects are passed back as GitHub sent them. A refusal is answered as GitHub's API answers
 *   one, `{"message": …}`: 401 for the token, 403 for an action the agent doesn't have, 404 for a
 *   connection it doesn't reach, 400 for a request that can't be relayed, and 502 where GitHub
 *   turned the connection's sign-in down or couldn't be reached.
 */

export const CLI_GITHUB_PATH = '/api/cli/github';

/** Who commits are made as. */
export const CLI_GITHUB_IDENTITY_PATH = `${CLI_GITHUB_PATH}/identity`;

/** git's smart HTTP, for `https://github.com/` to be rewritten to. */
export const CLI_GITHUB_GIT_PATH = `${CLI_GITHUB_PATH}/git`;

/** GitHub's API, for `https://api.github.com` to be rewritten to. */
export const CLI_GITHUB_API_PATH = `${CLI_GITHUB_PATH}/api`;

/** The GitHub connection a request is for, by its id; optional where the agent has only one. */
export const PAP_CONNECTION_HEADER = 'x-pap-connection';

/**
 * `GET CLI_GITHUB_IDENTITY_PATH`: the account the agent acts as on the connection, for git's
 * author and committer. `email` is GitHub's noreply address for the account,
 * `<id>+<login>@users.noreply.github.com`, which GitHub credits to it and accepts for a push
 * whatever its email privacy, never the person's own address.
 */
export type GitHubIdentity = {
	/** The connection's id. */
	connection: string;
	login: string;
	/** The account's name, or its login where it has none. */
	name: string;
	email: string;
};
