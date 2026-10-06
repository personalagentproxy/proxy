---
name: writing-result-code
description: Write compact ts-results-es / Do-notation code and refactor verbose Result chains. Use when writing or reviewing code that uses `Result`, `Do`, `Ok`, `Err`, `Result.wrap`, or `Result.wrapAsync` from `@proxy/utils` and `ts-results-es`.
---

# Writing Result code

The codebase uses `ts-results-es` with a `Do` helper from `@proxy/utils` instead of `try/catch`. This skill covers the compact patterns to write and the verbose patterns to refactor away.

Background: AGENTS.md describes the rules (no try/catch, errors as Results, `$()` to unwrap, `$(Err(...))` to short-circuit). This skill is about _style_ on top of those rules.

## Compact patterns

### 1. Do block over sequential isErr guards

When several Results compose, use `Do` with `$()` instead of stacked `isErr` branches. The early-return pattern in AGENTS.md applies, but `Do` collapses every "if isErr → return Err" into one character.

**Verbose:**

```ts
async function readAndValidate(response: Response, url: string): Promise<Result<T, FetchError>> {
	const text = await Result.wrapAsync<string, unknown>(async () => response.text());
	if (text.isErr()) {
		return Err({kind: 'parse', url, cause: text.error});
	}
	const value = Result.wrap<unknown, unknown>(() => JSON.parse(text.value) as unknown);
	if (value.isErr()) {
		return Err({kind: 'parse', url, cause: value.error});
	}
	const parsed = schema.safeParse(value.value);
	if (!parsed.success) {
		return Err({kind: 'schema', url, issues: parsed.error.issues});
	}
	return Ok(parsed.data);
}
```

**Compact:**

```ts
async function readAndValidate(response: Response, url: string): Promise<Result<T, FetchError>> {
	const toParseErr = (cause: unknown): FetchError => ({kind: 'parse', url, cause});
	return Do<T, FetchError>(async ($) => {
		const text = $((await Result.wrapAsync(async () => response.text())).mapErr(toParseErr));
		const value = $(Result.wrap(() => JSON.parse(text) as unknown).mapErr(toParseErr));
		const parsed = schema.safeParse(value);
		if (parsed.success) return parsed.data;
		return $(Err<FetchError>({kind: 'schema', url, issues: parsed.error.issues}));
	});
}
```

### 2. Extract repeated error-mapper closures

When the same `mapErr` shape appears more than once in a function, give it a name. Keeps the chain readable and dedupes the literal.

```ts
const toParseErr = (cause: unknown): FetchError => ({kind: 'parse', url, cause});
const a = $((await Result.wrapAsync(...)).mapErr(toParseErr));
const b = $(Result.wrap(...).mapErr(toParseErr));
```

### 3. `unwrapOr(null)` for "any failure → null"

When a chain of Results all collapse to the same sentinel (usually `null` or a default), `unwrapOr` is shorter than `Do`. Reach for `Do` only when errors propagate; reach for `unwrapOr` when they're discarded.

**Verbose:**

```ts
export function loadStoredToken(): string | null {
	if (!existsSync(CREDENTIALS_FILE)) return null;
	const raw = Result.wrap(() => readFileSync(CREDENTIALS_FILE, 'utf8'));
	if (raw.isErr()) return null;
	const json = Result.wrap<unknown, unknown>(() => JSON.parse(raw.value) as unknown);
	if (json.isErr()) return null;
	const parsed = schema.safeParse(json.value);
	if (!parsed.success) return null;
	return parsed.data.token;
}
```

**Compact:**

```ts
export function loadStoredToken(): string | null {
	if (!existsSync(CREDENTIALS_FILE)) return null;
	const raw = Result.wrap(() => readFileSync(CREDENTIALS_FILE, 'utf8')).unwrapOr(null);
	if (raw === null) return null;
	const json = Result.wrap<unknown, unknown>(() => JSON.parse(raw) as unknown).unwrapOr(null);
	const parsed = schema.safeParse(json);
	return parsed.success ? parsed.data.token : null;
}
```

### 4. `andThen` / `mapErr` for sync chains

`Do` takes a sync body too, but for two steps it is still more ceremony than the chain. Chain with `.andThen` (Result → Result) and `.mapErr` (E → E') instead.

```ts
function readJson<T>(path: string): Result<T, AlertsError> {
	if (!existsSync(path)) return Err({kind: 'missing_file', path});
	const raw = readFileSync(path, 'utf8');
	return Result.wrap<T, unknown>(() => JSON.parse(raw) as T).mapErr((cause) => ({
		kind: 'invalid_json',
		path,
		cause,
	}));
}
```

For two chained Results:

```ts
return substitute(raw, replacements, path).andThen((text) =>
	Result.wrap<T, unknown>(() => JSON.parse(text) as T).mapErr((cause) => ({
		kind: 'invalid_json',
		path,
		cause,
	})),
);
```

### 5. Extract shared Do blocks when callers duplicate them

If two exported functions wrap the same Do block with different inputs, extract the block as a private helper. Caller signatures stay clean; the body lives once.

```ts
async function callJson<S extends z.ZodType>(
	url: URL,
	init: RequestInit,
	endpoint: string,
	schema: S,
): Promise<Result<z.infer<S>, CliError>> {
	return Do<z.infer<S>, CliError>(async ($) => {
		const raw = $((await httpRequest(url, init, {schema: z.unknown()})).mapErr(fetchErrToCli));
		$(rejectToolFailureBody(raw));
		return $(validateWith(schema, raw, endpoint));
	});
}

export async function callTool<S extends z.ZodType>(...) {
	return callJson(new URL(endpoint, apiUrl), {method: 'POST', ...}, endpoint, schema);
}

export async function getJson<S extends z.ZodType>(...) {
	return callJson(new URL(endpoint, apiUrl), {headers: authHeaders(token)}, endpoint, schema);
}
```

### 6. Type-narrow the `Err` short-circuit

Inside a `Do<T, E>`, `$(Err(...))` works but TS sometimes widens the error type. Annotate the call site to keep the discriminated union narrow:

```ts
return $(Err<FetchError>({kind: 'schema', url, issues: parsed.error.issues}));
```

## Refactor checklist

When reviewing or simplifying existing Result code, look for:

- [ ] **Repeated `if (x.isErr()) return Err({...})`** in one function → collapse with `Do` + `mapErr`.
- [ ] **Repeated error-object literals** (e.g. `{kind: 'parse', url, cause: ...}` three times) → extract a `toXErr` closure.
- [ ] **Two functions with the same Do body** → extract a private helper.
- [ ] **`isErr() return null`** (or any same-sentinel collapse) → `.unwrapOr(sentinel)`.
- [ ] **Two-step sync chains using `Do`** → switch to `.andThen` / `.mapErr`.
- [ ] **Explicit `Result.wrapAsync<T, unknown>(...)` generics** → drop them if the callback's return type infers cleanly.
- [ ] **Verbose existence checks before `JSON.parse`** (`typeof === 'object'`, `Array.isArray`, …) → replace with a zod schema (`z.record(z.string(), z.unknown())`, `z.discriminatedUnion`, etc.).

## When NOT to use Do

`Do` shines when errors share a single output type. Skip it when:

- **Each error maps to a distinct output variant** (e.g. an outcome type with `network_error`, `http_error` and `unwritable` variants — Do would force an awkward intermediate `E` type, and the explicit `isErr` branches read more clearly).
- **The "error" path is a normal control-flow signal** that should be discarded (use `unwrapOr` instead).
- **There's only one Result to handle.** Just check it directly.

## Rules of thumb

- Reach for `Do` once you have **two or more sequential** Results that share an error type.
- Reach for `.mapErr` to translate errors across boundaries (e.g. `FetchError` → `CliError`); name the translator if used more than twice.
- Reach for `.andThen` for sync two-step chains.
- Reach for `.unwrapOr` when the function's signature already absorbs failure (`T | null`, `T`).
- Name the closure when it appears more than once — even a 1-line `(cause) => ({kind: 'parse', url, cause})` literal earns a name on its third appearance.

## Reference: imports

```ts
import {Do} from '@proxy/utils';
import {Err, Ok, Result} from 'ts-results-es';
```

`Do`, `requirePresent`, `parseSchema`, `httpRequest`, `formatFetchError`, and `readJsonValidated` all export from `@proxy/utils`. Error mappers (e.g. `fetchErrToCli`) live next to the error type they produce.
