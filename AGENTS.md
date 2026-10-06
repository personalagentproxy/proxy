# Proxy

## Commands

- `bun run setup` - Link AI skills into `.claude/skills` and `.codex/skills`, and configure git hooks (`.githooks/pre-commit` formats staged files with prettier)
- `bun run dev` - Start the web app (`packages/web`, http://localhost:5173)
- `bun run typecheck` - Typecheck all packages
- `bun run test` - Run every package's tests (`bun test`)
- `bun run lint` - Lint the web app with oxlint
- `bun run build` - Production build of the web app

## Layout

- `packages/web` - Vite + React + Tailwind + stock shadcn UI (`base-nova` style on Base UI, `components.json`). Add components with `bunx --bun shadcn add <name>` from `packages/web`. The only local change to the shadcn files is one size step up on controls (buttons, inputs, selects, input groups) so they match common app sizing; re-apply it if a component is re-added.
- `packages/utils` - `@proxy/utils`, the Result helpers shared by every package: `Do`, `requirePresent` and `parseSchema` (`src/parse.ts`), and `httpRequest`, the fetch wrapper that returns a `FetchError` union instead of throwing (`src/fetch.ts`)
- `skills/` - Agent skills, symlinked into `.claude/skills` and `.codex/skills` by `bun run setup`

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
