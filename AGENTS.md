# Personal Agent Proxy

## Commands

- `bun run setup` - Link AI skills into `.claude/skills` and `.codex/skills`, and configure git hooks (`.githooks/pre-commit` formats staged files with prettier)
- `bun run dev` - Start the local database, then the api (http://localhost:4000), the web app (http://localhost:5173, which proxies `/api/`, `/auth/` and `/agent-auth/` to the api, so the browser sees one origin as in production), the docs (http://localhost:5174) and the website (http://localhost:5175). Copy `.env.example` to `.env` first
- `bun run website` - Start only the website (http://localhost:5175), without the database, the api or the other apps
- `bun run seed` - With `bun run dev` up, fill the local database with a demo workspace (connections, agents with settings of their own, activity) and print a sign-in link for `demo@proxy.local`. Re-running replaces it
- `bun run --cwd packages/db db:migrate:diff` - With the database running, print the SQL from the database to `schema.prisma`; save it as `packages/db/prisma/migrations/<name>/migration.sql`. `bun run dev` applies pending migrations on start
- `bun run typecheck` - Typecheck all packages
- `bun run test` - Run every package's tests (`bun test`; the api's with `--isolate`, since its tests mock modules per file)
- `bun run lint` - Lint the web app, the docs and the website with oxlint
- `bun run build` - Production builds of the web app, the docs and the website
- `docker build -t proxy .` - The self-hosting image (`Dockerfile`): the api serving the web app's build on one origin, applying the migrations on start (`docker-entrypoint.sh`). `docker-compose.yml` runs it with Postgres and Caddy; `.github/workflows/image.yml` publishes it to `ghcr.io/personalagentproxy/proxy`. Hosted Personal Agent Proxy runs on Render from `render.yaml`: the image as one service (api and web app on one origin, two instances), Render Postgres, and the docs and the website as static sites

## Layout

- `packages/ui` - `@proxy/ui`, the styling the web app, the docs and the website share: the Tailwind theme (`src/styles.css`, imported by each app's own stylesheet) and stock shadcn UI (`base-nova` style on Base UI) in `src/components`, imported as `@proxy/ui/components/<name>`. Add components with `bunx --bun shadcn add <name>` from `packages/web` or `packages/docs`, which puts them here. The only local change to the shadcn files is one size step up on controls (buttons, inputs, selects, input groups) so they match common app sizing; re-apply it if a component is re-added.
- `packages/web` - Vite + React + Tailwind, styled with `@proxy/ui`.
- `packages/docs` - The docs, a Next app styled with `@proxy/ui` and exported as static files (`output: 'export'`, every page `<path>/index.html` with trailing-slash URLs). Pages are MDX in `content/` (the path is the URL, a folder's `index.mdx` is the folder) with a `title` and `description` in their frontmatter, listed in order in `src/nav.ts`, the sidebar. `src/lib/docs.ts` compiles them at build time (GFM, heading ids, Shiki), and `src/components/mdx-components.tsx` styles each element and gives pages `<Callout>` and `<Steps>` without an import. Every page is prerendered; a page missing from `src/nav.ts`, or bad frontmatter, fails the build.
- `packages/website` - The website at personalagentproxy.com, a Next app styled with `@proxy/ui` and exported as static files like the docs. Its buttons lead to the app's two sign-in pages, `/login` and `/agent/login`, on `http://localhost:5173` in development and `https://app.personalagentproxy.com` once built. Above the headline, `LogoDock` (`src/components/logo-dock.tsx`) shows Personal Agent Proxy between the agents and the services, each side scrolling through its logos (in `public/logos/`); the tiles' shadow and lighting are `.logo-tile` in `src/app/globals.css`, tuned with sliders that only `bun run dev` shows (`logo-dock-tuner.tsx`).
- `packages/utils` - `@proxy/utils`, the Result helpers shared by every package: `Do`, `requirePresent` and `parseSchema` (`src/parse.ts`), and `httpRequest`, the fetch wrapper that returns a `FetchError` union instead of throwing (`src/fetch.ts`). Also `ApiError`/`ApiErr` and `wrapDb` (`src/api-error.ts`), the error every server-side function returns, and the session cookie's name and parsing (`src/session-cookie.ts`)
- `packages/integrations` - `@proxy/integrations`, the catalog the api and the web app share: each integration's actions, collections and fields (`src/catalog.ts`), the agents a login can be made for (`src/agent-providers.ts`), the email providers' servers (`src/email-providers.ts`), and access (`src/access.ts`): per action of a connection, an agent's own setting, else the connection's default, an action counting only with the one it `requires`. The web app adds the icons (`src/lib/integrations.ts`)
- `packages/db` - `@proxy/db`: Prisma 6 on Postgres. `src/index.ts` is the client; each module (`auth.ts`, `user.ts`, `organization.ts`, `connection.ts`, `info.ts`, `agent.ts`, `audit.ts`) exports functions returning `Result<T, ApiError>` through `wrapDb`. `relationMode = "prisma"`: no foreign keys in the database, so Prisma runs the cascades and every relation column has its own index. Locally the database is Prisma's embedded Postgres (PGlite, `scripts/dev-db.ts`), which needs `connection_limit=1&pgbouncer=true` in `DATABASE_URL`
- `packages/api` - `@proxy/api`: Express on Bun. Routes are `handleXRoute` functions mounted in `src/server/create-api-router.ts`; JSON routes return `Result<T, ApiError>` through `withAuthResult`, which puts the signed-in user on `req.user`. Every environment variable is in `src/utils/env-schema.ts` with its docs, which the docs' Environment variables page is built from; add new ones there. Personal Agent Proxy is one origin everywhere: when `packages/web/dist` exists, as in the Docker image, the api serves the web app's build too (`src/server/serve-web.ts`), and every address the api builds starts from `APP_URL`. Browser-called writes take `requireBrowserOrigin` (CSRF); there is no CORS. `src/connections/` lists, deletes and sets defaults on an organization's connections, connects a mailbox with an app password after signing in to its IMAP and SMTP servers (`email/`), and connects Granola by signing in to it (`granola/`: OAuth with PKCE against the authorization server of Granola's MCP server, a client registered for each sign-in, the handshake in an encrypted cookie; tokens are refreshed as they run out and saved only over the ones they replace), notes and transcripts on by default. `src/agents/` makes, revokes and deletes agent logins (the password is sent once, only its argon2id hash is kept) and sets an agent's own settings per action of a connection where they differ from the default. `src/records/` reads and writes a collection's records through the integration's `Connector` (`connectors.ts`): Information's live in the database (`info-connector.ts`), a mailbox's are fetched over IMAP on every request (`email-connector.ts`), which merges the inbox and the folders the server marks as Drafts and Sent into one list (ids start with the folder: `inbox-…`, `drafts-…`, `sent-…`) and runs the commands: flags, moves to the folders the server marks as Archive (Gmail's All Mail) or Trash, and sending over SMTP, a draft or a new email, filing a copy in Sent where the server doesn't (Gmail does). Received emails are never edited or deleted for good; only drafts are. Granola's notes are fetched from its MCP server on every request (`granola-connector.ts`; the calls, one stateless `tools/call` each, and the reading of the XML-like text Granola answers in are in `connections/granola/granola-mcp.ts`): its Notes and Transcripts collections are the same meetings by Granola's meeting id, and since Granola's tools have no pages, a page is 30 days of meetings; one that finds none skips back to the newest meeting before it, so the list ends where the meetings do. Granola's dates and attendees are shown as Granola writes them. Lists take `?search=` (only where the collection has a `searchHint`; Granola has none), `?filter=` (the collection's `filterField`, such as `?filter=Draft`) and `?page=` (`list-query.ts`) and answer a page, newest first (a mailbox's 50 emails, Granola's 30 days), with the next page's token; a mailbox's token holds where each folder goes on, so paging through the merged list shows every email once, and its search uses Gmail's own syntax on Gmail (`X-GM-EXT-1`) and IMAP text search elsewhere. Agents sign in at `/agent-auth/login` with a cookie of their own (`src/agent-auth/`); `src/agent-side/` serves them through the same connectors, checks every request against their access and logs it, denied ones too, to the activity log that `src/activity/` lists; credentials and Information records are stored encrypted with `ENCRYPTION_KEY` (`src/utils/secret-crypto.ts`). Has its own `.prettierrc.json` with a 200-column print width
- `skills/` - Agent skills, symlinked into `.claude/skills` and `.codex/skills` by `bun run setup`

## The app

Personal Agent Proxy holds the integrations and personal information an AI agent needs, so every agent company does not have to rebuild them and you do not have to trust each one's security. A human connects services and hands out agent logins; an agent signs in with one and works through what it was given. Everything is served by `packages/api`; the web app has no data of its own.

- **Model**: an integration from the catalog (`@proxy/integrations`: Email over IMAP and SMTP, and Granola's meeting notes over its MCP server) has the actions an agent can be allowed with a connection of it (Read, Archive, Write drafts, Send) and collections, each a list of fields with the actions reading and writing it need, and the commands it offers beyond editing (Mark as read, Archive, Send), each needing one action. A command runs on a `record`, where its `where` picks out which (Archive only in the inbox, Send only on a draft), or on values typed in (`new`: sending a new email). A mailbox is one collection, its folder a field the agent side filters by. Integrations join the catalog once they work end to end; Google Workspace, Notion and Linear come later. A connection is a connected integration and its account, owned by the organization; an integration can be connected more than once, such as two mailboxes. Information is the built-in `info` connection (addresses, payment cards, notes), made with the organization, so access and the agent side treat it like any other. Nothing is copied from a provider: every request goes to it live. Fields marked `system` are set by the provider, never typed in.
- **Access** is one list of actions per connection, and every action the catalog lists can be set: what Personal Agent Proxy can do with the provider is the limit. Two layers: the connection's default (a `ConnectionDefault` row per action that is on) and an agent's own setting, on or off, where it differs (`AgentGrant`). An agent gets its own setting, else the default as it is now; an action that `requires` another counts only with it (Archive needs Read; Send needs nothing, so an agent can send without reading the mailbox). A collection's `writes` name the action creating, editing and deleting need, and `editable` which records they apply to (drafts). An agent login is for one agent from `AGENT_PROVIDERS`; each organization can have one login per company. It has a generated username and a password that is shown once. Every request on the agent side is an audit entry, allowed or denied, with what a list searched for.
- **Accounts**: a human signs in with Google or a magic link (`src/auth/` in the api). A session is a `Session` row and an httpOnly cookie; the web app's `/api/me` loader on the human side's route redirects to `/login?callbackUrl=…` without one. Every user gets one `Organization` at sign-up, created with the user. `ALLOWED_SIGNUP_EMAILS` limits who can sign up; the login page asks `/auth/methods` whether to offer Google. In development the login page has a Create dev user button; in development, or without `RESEND_KEY`, the api prints magic links instead of emailing them. Cookies are secure when `APP_URL` is HTTPS.
- **Human side** behind `/login`: `/connections`, `/connections/new` (connects a mailbox with an app password, or Granola by signing in to it), `/connections/:id` (the defaults, with how many agents differ per action), `/info`, `/agents` (chooses an agent company that does not have a login yet), `/agents/:id` (the password shows once, after creating or resetting; access laid out like an editor's settings: one checkbox per action of each connection, the only control for it, each connection folded by default to a row saying Default or Changed; a setting of the agent's own is marked with a bar, a button that makes it the connection's default for every agent, and one that resets it, and a filter and Changed only narrow the list; `ConnectionAccess` serves both pages), `/activity` (filters in the URL, so the agent and connection pages link to their part of the log). Each page has a loader in `src/loaders.ts` and revalidates after a change. Layout follows the spanish repo: the shadcn sidebar as a rail, an `h-12` header, one `max-w-3xl` column, one-line `RowList` rows. Type has one size, `text-sm`, in rows, summaries and hints alike, except column headers (`RowHeader`), which are `text-xs`: the thing itself in the normal colour, what is said about it (column headers, times, summaries, descriptions) in `text-muted-foreground`, and `font-medium` only for page and section titles.
- **Agent side** behind `/agent/login`, with its own cookie: `/agent` lists what the login can do with each connection and the lists it can open, `/agent/:connection/:collection` a collection's records (newest first, 50 to a page with an Older link, narrowed by its `filterField`, such as the folder, and searched where the collection has a `searchHint`, which says what the search takes), `…/new` and `…/:record` the generic `RecordForm` and `RecordFields`, with a button per command the agent may run on the record, and Send beside Save as draft on a new email (loaders in `src/agent-loaders.ts`). It is built for a model driving a browser: no sidebar, no icon-only buttons, nothing that only shows on hover. Lists it can neither read nor add to are left out, and one it can only add to (sending without Read) opens on its form; asking for one anyway shows the api's refusal, which it logs as denied.
- **Testing email locally**: any IMAP server with TLS on 993 and SMTP on 465 or 587 works through Other. A self-signed one needs `NODE_TLS_REJECT_UNAUTHORIZED=0` on the api, never in production. The server's hostname needs a dot and can't be an IP address: `localhost4.localdomain4` reaches 127.0.0.1 on most Linux machines.

## Code Style

### Early Returns

Always use early returns. Avoid indentation. Avoid `else` statements.

```typescript
// Good
function process(item: Item | null): Result<Data, Error> {
	if (!item) {
		return Err(new Error('No item'));
	}

	if (!item.isValid) {
		return Err(new Error('Invalid item'));
	}

	return Ok(item.data);
}

// Bad
function process(item: Item | null): Result<Data, Error> {
	if (item) {
		if (item.isValid) {
			return Ok(item.data);
		} else {
			return Err(new Error('Invalid item'));
		}
	} else {
		return Err(new Error('No item'));
	}
}
```

When returning early, use parentheses (no inline returns).

### No Switch Statements

Use `if` with early returns instead of `switch`.

```typescript
// Good
function handle(type: string) {
	if (type === 'a') {
		return handleA();
	}

	if (type === 'b') {
		return handleB();
	}

	return handleDefault();
}

// Bad
function handle(type: string) {
	switch (type) {
		case 'a':
			return handleA();
		case 'b':
			return handleB();
		default:
			return handleDefault();
	}
}
```

### Error Handling with ts-results-es

Don't use big try/catch blocks. Use `Result` types from `ts-results-es`.

#### The Do Utility (Preferred)

Use `Do` for chaining Result operations (the body may be async or sync):

```typescript
import {Do} from '@proxy/utils';
import {Err} from 'ts-results-es';

export async function handleRequest(
	userId: string,
	projectId: string,
): Promise<Result<{data: string}, Error>> {
	return Do(async ($) => {
		// $() unwraps Result - returns value if Ok, short-circuits if Err
		const session = $(await resolveSession());
		const project = $(await getProject(projectId));

		// Early return error with $(Err(...))
		if (!project.isActive) {
			return $(Err(new Error('Project is archived')));
		}

		// Unwrap more results
		const data = $(await fetchData(project.id));

		// Return success value (automatically wrapped in Ok)
		return {data};
	});
}
```

#### Do Rules

1. **Use `$()` to unwrap Results** - auto short-circuits on Err
2. **Return errors with `$(Err(...))`** - not `throw new Error()`
3. **Return success values directly** - wrapped in Ok automatically
4. **NEVER throw inside Do** - only `$()` errors are caught

```typescript
// Returning errors inside Do
if (items.length === 0) {
	return $(Err(new Error('No items'))); // Correct
}

if (items.length === 0) {
	throw new Error('No items'); // WRONG - unhandled exception
}
```

#### Result.wrapAsync (For External APIs)

When calling external code that throws:

```typescript
const result = await Result.wrapAsync<Data, Error>(async () => {
	return await externalApiThatMightThrow();
});

if (result.isErr()) {
	return Err(result.error);
}
const data = result.value;
```

### Strict Typing

Never use `any` or `unknown` to fix type issues. Understand the types deeply. If you feel you must use them, ask first.

### Dead Code

If you come across dead code while doing other work — unused exports, unreferenced helpers, unreachable branches, comments describing paths that no longer exist — delete it. Don't extend it to "stay aligned" with stale docs, and don't preserve it "for future use." That's how it became dead in the first place. When unsure whether something is reachable, verify with typecheck and `grep` for callers before deleting.

### File Naming

Use kebab-case, all lowercase:

- `notes.md`
- `hello.ts`
- `some-file.ts`

If you see a file not conforming, notify the user and rename.

## Communication

Don't flatter the user. Skip openers like "great question", "good catch", "you're absolutely right". Respond to what was said — agreement is fine when it's substantive, but the praise preamble is noise.

## Git

Never add Claude or Codex to any commit, message or pull request.

## Scheduling

Never offer to `/schedule` follow-up work. Do not suggest scheduling background agents, recurring tasks, or one-time future runs at the end of replies.
