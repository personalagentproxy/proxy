# Proxy

## Commands

- `bun run setup` - Link AI skills into `.claude/skills` and `.codex/skills`, and configure git hooks (`.githooks/pre-commit` formats staged files with prettier)
- `bun run dev` - Start the local database, then the web app (http://localhost:5173). Copy `.env.example` to `.env` first
- `bun run --cwd packages/db db:migrate:diff` - With the database running, print the SQL from the database to `schema.prisma`; save it as `packages/db/prisma/migrations/<name>/migration.sql`. `bun run dev` applies pending migrations on start
- `bun run typecheck` - Typecheck all packages
- `bun run test` - Run every package's tests (`bun test`)
- `bun run lint` - Lint the web app with oxlint
- `bun run build` - Production build of the web app

## Layout

- `packages/web` - Vite + React + Tailwind + stock shadcn UI (`base-nova` style on Base UI, `components.json`). Add components with `bunx --bun shadcn add <name>` from `packages/web`. The only local change to the shadcn files is one size step up on controls (buttons, inputs, selects, input groups) so they match common app sizing; re-apply it if a component is re-added.
- `packages/utils` - `@proxy/utils`, the Result helpers shared by every package: `Do`, `requirePresent` and `parseSchema` (`src/parse.ts`), and `httpRequest`, the fetch wrapper that returns a `FetchError` union instead of throwing (`src/fetch.ts`). Also `ApiError`/`ApiErr` and `wrapDb` (`src/api-error.ts`), the error every server-side function returns, and the session cookie's name and parsing (`src/session-cookie.ts`)
- `packages/db` - `@proxy/db`: Prisma 6 on Postgres. `src/index.ts` is the client; each module (`auth.ts`, `user.ts`, `organization.ts`) exports functions returning `Result<T, ApiError>` through `wrapDb`. `relationMode = "prisma"`: no foreign keys in the database, so Prisma runs the cascades and every relation column has its own index. Locally the database is Prisma's embedded Postgres (PGlite, `scripts/dev-db.ts`), which needs `connection_limit=1&pgbouncer=true` in `DATABASE_URL`
- `skills/` - Agent skills, symlinked into `.claude/skills` and `.codex/skills` by `bun run setup`

## The app

Proxy holds the integrations and personal information an AI agent needs, so every agent company does not have to rebuild them and you do not have to trust each one's security. A human connects services and hands out agent logins; an agent signs in with one and works through what it was given. For now `packages/web` is a mock UI with no backend.

- **Model** (`src/lib/types.ts`): an integration from the catalog (`src/lib/integrations.ts`: Google Workspace with Gmail, Calendar, Contacts, Drive, Docs and Sheets as collections; Notion; Linear) exposes collections, each a list of fields. A connection is a connected integration and its account. Information is the built-in `info` connection (addresses, payment cards, notes), so access and the agent side treat it like any other. An agent login has a generated username and password and a grant per connection and collection: none, read, or read and write. Every request on the agent side is an audit entry, allowed or denied. Fields marked `system` are set by the provider, never typed in.
- **Human side** behind `/login` (any email and password get in): `/connections`, `/connections/new` (Connect stands in for the provider's sign-in and brings its sample records), `/connections/:id`, `/info`, `/agents`, `/agents/:id` (the password shows once, after creating or resetting; one select per collection sets access), `/activity` (filters in the URL, so the agent and connection pages link to their part of the log). Layout follows the spanish repo: the shadcn sidebar as a rail, an `h-12` header, one `max-w-3xl` column, one-line `RowList` rows.
- **Agent side** behind `/agent/login`: `/agent` lists what the login can reach, `/agent/:connection/:collection` a collection's records, `…/new` and `…/:record` the generic `RecordForm` and `RecordFields`. It is built for a model driving a browser: no sidebar, no icon-only buttons, nothing that only shows on hover. Collections without access are left out; asking for one anyway shows a refusal and logs a denied request (`useAuditOnce` in `src/hooks/use-audit.ts`).
- **State**: `MockStoreProvider` in `src/components/mock-store.tsx` keeps the fixtures from `src/lib/mock-data.ts` in React state, so changes hold while you click around and the agent side's requests show up in the human side's activity. A reload starts over from the fixtures; only who is signed in on each side survives it, in session storage.

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
