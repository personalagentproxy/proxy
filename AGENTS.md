# Personal Agent Proxy

## Commands

- `bun run setup` - Link AI skills into `.claude/skills` and `.codex/skills`, and configure git hooks (`.githooks/pre-commit` formats staged files with prettier)
- `bun run dev` - Stop any `bun run dev` already running on the machine (`scripts/dev.mjs` notes its processes in `proxy-dev.json` in the temp directory), start the local database, then the api (http://localhost:4000), the web app (http://localhost:5173, which proxies `/api/`, `/auth/`, `/agent-auth/`, `/mcp`, `/oauth/` and `/.well-known/` to the api, so the browser sees one origin as in production), the docs (http://localhost:5174) and the website (http://localhost:5175). Copy `.env.example` to `.env` first
- `bun run docs` - Start only the docs (http://localhost:5174), without the database, the api or the other apps
- `bun run website` - Start only the website (http://localhost:5175), without the database, the api or the other apps
- `bun run map` - Start the screen map (http://localhost:5176), the development-only canvas of every screen of the web app and the ways between them. It shows what `bun run crawl` in `packages/map` last wrote: with `bun run dev` up, the crawl seeds the demo workspace, signs in as a person, as a new organization and as an agent, visits every route in the web app's router, screenshots each and notes its links. Everything it writes is in `packages/map/generated`, which is gitignored
- `bun run seed` - With `bun run dev` up, fill the local database with a demo workspace (connections, agents with settings of their own, activity) and print a sign-in link for `demo@proxy.local`. Re-running replaces it
- `bun run --cwd packages/db db:migrate:diff` - With the database running, print the SQL from the database to `schema.prisma`; save it as `packages/db/prisma/migrations/<name>/migration.sql`, the name `v` and the next three-digit number, such as `v011_add_x`: Prisma applies migrations in the order their names sort as text, so `10_x` would run before `9_mcp_oauth` (a test refuses any other name). `bun run dev` applies pending migrations on start
- `bun run typecheck` - Typecheck all packages
- `bun run test` - Run every package's tests (`bun test`; the api's with `--isolate`, since its tests mock modules per file)
- `bun run lint` - Lint the web app, the docs and the website with oxlint
- `bun run build` - Production builds of the web app, the docs and the website
- `docker build -t proxy .` - The self-hosting image (`Dockerfile`): the api serving the web app's build on one origin, applying the migrations on start (`docker-entrypoint.sh`). `docker-compose.yml` runs it with Postgres and Caddy; `.github/workflows/image.yml` publishes it to `ghcr.io/personalagentproxy/proxy`. Hosted Personal Agent Proxy runs on Render from `render.yaml`: the image as one service (api and web app on one origin, two instances), Render Postgres, and the docs and the website as static sites

## Running the Stack for the User

When the user asks you to run the stack so they can use it (sign in, connect an integration, try a change), they open it by binding your machine's ports to their own localhost: the web app at http://localhost:5173 in their browser is yours. Keep `APP_URL="http://localhost:5173"` in `.env` and don't share a preview or tunnel URL instead: the api refuses sign-ins and other writes from any origin but `APP_URL`, and OAuth sign-ins (Google, Granola, Notion, Linear) return to it.

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

## Real Data

When you test against the user's real accounts (their Granola, mail, files, calendars), never let what you saw leave the conversation with them: no names, meeting titles, notes, quotes or other details of theirs in code, comments, tests, fixtures, commit messages or pull requests. Write invented examples instead ("Pricing review with Dana"), and don't say that something was tested against a real account.

## Git

NEVER give Claude or Codex credit for any commit, message or pull request.

## Scheduling

Never offer to `/schedule` follow-up work. Do not suggest scheduling background agents, recurring tasks, or one-time future runs at the end of replies.

## Editing this file

Never edit `AGENTS.md`. If information in this file becomes outdated as a result of a change that was made, alert the user but don't do the edit yourself unless explicitly asked.
