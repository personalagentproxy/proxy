# Proxy

## Commands

- `bun run setup` - Link AI skills into `.claude/skills` and `.codex/skills`, and configure git hooks (`.githooks/pre-commit` formats staged files with prettier)
- `bun run dev` - Start the local database, then the api (http://localhost:4000) and the web app (http://localhost:5173). Copy `.env.example` to `.env` first
- `bun run --cwd packages/db db:migrate:diff` - With the database running, print the SQL from the database to `schema.prisma`; save it as `packages/db/prisma/migrations/<name>/migration.sql`. `bun run dev` applies pending migrations on start
- `bun run typecheck` - Typecheck all packages
- `bun run test` - Run every package's tests (`bun test`; the api's with `--isolate`, since its tests mock modules per file)
- `bun run lint` - Lint the web app with oxlint
- `bun run build` - Production build of the web app

## Layout

- `packages/web` - Vite + React + Tailwind + stock shadcn UI (`base-nova` style on Base UI, `components.json`). Add components with `bunx --bun shadcn add <name>` from `packages/web`. The only local change to the shadcn files is one size step up on controls (buttons, inputs, selects, input groups) so they match common app sizing; re-apply it if a component is re-added.
- `packages/utils` - `@proxy/utils`, the Result helpers shared by every package: `Do`, `requirePresent` and `parseSchema` (`src/parse.ts`), and `httpRequest`, the fetch wrapper that returns a `FetchError` union instead of throwing (`src/fetch.ts`). Also `ApiError`/`ApiErr` and `wrapDb` (`src/api-error.ts`), the error every server-side function returns, and the session cookie's name and parsing (`src/session-cookie.ts`)
- `packages/integrations` - `@proxy/integrations`, the catalog the api and the web app share: each integration's collections and fields (`src/catalog.ts`), the email providers' servers (`src/email-providers.ts`), and access (`src/access.ts`): an agent's own setting, else the connection's default, capped by what the provider allows (received emails are read-only). The web app adds the icons (`src/lib/integrations.ts`)
- `packages/db` - `@proxy/db`: Prisma 6 on Postgres. `src/index.ts` is the client; each module (`auth.ts`, `user.ts`, `organization.ts`, `connection.ts`, `info.ts`, `agent.ts`, `audit.ts`) exports functions returning `Result<T, ApiError>` through `wrapDb`. `relationMode = "prisma"`: no foreign keys in the database, so Prisma runs the cascades and every relation column has its own index. Locally the database is Prisma's embedded Postgres (PGlite, `scripts/dev-db.ts`), which needs `connection_limit=1&pgbouncer=true` in `DATABASE_URL`
- `packages/api` - `@proxy/api`: Express on Bun. Routes are `handleXRoute` functions mounted in `src/server/create-api-router.ts`; JSON routes return `Result<T, ApiError>` through `withAuthResult`, which puts the signed-in user on `req.user`. Browser-called routes take `apiCorsMiddleware` and `requireBrowserOrigin` (CSRF). `src/connections/` lists, deletes and sets defaults on an organization's connections, and connects a mailbox with an app password after signing in to its IMAP and SMTP servers (`email/`). `src/agents/` makes, revokes and deletes agent logins (the password is sent once, only its argon2id hash is kept) and sets an agent's own access where it differs from the default. `src/records/` reads and writes a collection's records through the integration's `Connector` (`connectors.ts`): Information's live in the database (`info-connector.ts`), a mailbox's are fetched over IMAP on every request (`email-connector.ts`). Agents sign in at `/agent-auth/login` with a cookie of their own (`src/agent-auth/`); `src/agent-side/` serves them through the same connectors, checks every request against their access and logs it, denied ones too, to the activity log that `src/activity/` lists; credentials and Information records are stored encrypted with `ENCRYPTION_KEY` (`src/utils/secret-crypto.ts`). Has its own `.prettierrc.json` with a 200-column print width
- `skills/` - Agent skills, symlinked into `.claude/skills` and `.codex/skills` by `bun run setup`

## The app

Proxy holds the integrations and personal information an AI agent needs, so every agent company does not have to rebuild them and you do not have to trust each one's security. A human connects services and hands out agent logins; an agent signs in with one and works through what it was given. Everything is served by `packages/api`; the web app has no data of its own.

- **Model**: an integration from the catalog (`@proxy/integrations`: Email over IMAP, with emails and drafts as collections) exposes collections, each a list of fields. Integrations join the catalog once they work end to end; Google Workspace, Notion and Linear come later. A connection is a connected integration and its account, owned by the organization; an integration can be connected more than once, such as two mailboxes. Information is the built-in `info` connection (addresses, payment cards, notes), made with the organization, so access and the agent side treat it like any other. Nothing is copied from a provider: every request goes to it live. Fields marked `system` are set by the provider, never typed in.
- **Access** has three layers per connection and collection: what the provider allows (received emails are read-only), the connection's default, and an agent's own setting where it differs from the default. An agent gets its own setting, else the default as it is now, capped by the provider; a setting above the provider is refused. An agent login has a generated username and a password that is shown once. Every request on the agent side is an audit entry, allowed or denied.
- **Accounts**: a human signs in with Google or a magic link (`src/auth/` in the api). A session is a `Session` row and an httpOnly cookie; the web app's `/api/me` loader on the human side's route redirects to `/login?callbackUrl=…` without one. Every user gets one `Organization` at sign-up, created with the user. In development the login page has a Create dev user button and the api prints magic links instead of emailing them.
- **Human side** behind `/login`: `/connections`, `/connections/new` (connects a mailbox with an app password), `/connections/:id` (the defaults), `/info`, `/agents`, `/agents/:id` (the password shows once, after creating or resetting; one select per collection, starting on the default, with a setting of the agent's own marked Changed), `/activity` (filters in the URL, so the agent and connection pages link to their part of the log). Each page has a loader in `src/loaders.ts` and revalidates after a change. Layout follows the spanish repo: the shadcn sidebar as a rail, an `h-12` header, one `max-w-3xl` column, one-line `RowList` rows.
- **Agent side** behind `/agent/login`, with its own cookie: `/agent` lists what the login can reach, `/agent/:connection/:collection` a collection's records (newest first, 50 to a page, with a search: Gmail's own syntax on Gmail, the words in headers and text elsewhere), `…/new` and `…/:record` the generic `RecordForm` and `RecordFields` (loaders in `src/agent-loaders.ts`). It is built for a model driving a browser: no sidebar, no icon-only buttons, nothing that only shows on hover. Collections without access are left out; asking for one anyway shows the api's refusal, which it logs as denied.
- **Testing email locally**: any IMAP server with TLS on 993 and SMTP on 465 or 587 works through Other. A self-signed one needs `NODE_TLS_REJECT_UNAUTHORIZED=0` on the api, never in production.

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
