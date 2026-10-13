import {Err, Ok, Result} from 'ts-results-es';
import {z} from 'zod';

import {agentSessionCookieNames, Do, httpRequest, type FetchError} from '@proxy/utils';

import type {JsonValue, Params} from './args';
import {CliErr, type CliError} from './cli-error';
import type {Session} from './session';

/**
 * The agent side of a Personal Agent Proxy server, as the web app's agent pages use it: signing in
 * at `/agent-auth/login` for a cookie, then `/api/agent/*` with it. Writes carry the server's own
 * origin, which its CSRF guard takes and nothing else, and every request says it comes from the
 * command line, which the activity log shows and nothing else depends on. Redirects aren't
 * followed: the cookie only ever goes to the origin signed in to.
 */

const TIMEOUT_MS = 60_000;

export const CLIENT_HEADERS = {'X-Proxy-Client': 'cli'};

const agentConnectionSchema = z.object({
	id: z.string(),
	integrationId: z.string(),
	account: z.string(),
	actions: z.array(z.string()),
});

export const meSchema = z.object({
	agent: z.object({id: z.string(), providerId: z.string(), name: z.string()}),
	connections: z.array(agentConnectionSchema),
});

export type Me = z.infer<typeof meSchema>;

const toolSchema = z.object({
	name: z.string(),
	title: z.string(),
	description: z.string(),
	readOnly: z.boolean(),
	inputSchema: z.object({
		properties: z.record(
			z.string(),
			z.object({type: z.string(), description: z.string(), enum: z.array(z.string()).optional()}),
		),
		required: z.array(z.string()),
	}),
});

export const toolsSchema = z.object({tools: z.array(toolSchema)});

export type ToolInfo = z.infer<typeof toolSchema>;

const recordSchema = z.object({
	id: z.string(),
	values: z.record(z.string(), z.string()),
	updatedAt: z.string(),
	hasChildren: z.boolean().optional(),
});

export type DataRecord = z.infer<typeof recordSchema>;

// A page of a list, or the record a tool opened, wrote or ran on: null once it is gone.
export const toolResultSchema = z.union([
	z.object({
		records: z.array(recordSchema),
		nextPage: z.string().nullable(),
		trail: z.array(z.object({id: z.string(), title: z.string()})).optional(),
	}),
	z.object({record: recordSchema.nullable()}),
]);

export type ToolResult = z.infer<typeof toolResultSchema>;

// An answer: its status, and its body as JSON, or null when it had none.
type Answer = {status: number; body: JsonValue | null; response: Response};

const errorBodySchema = z.object({error: z.string(), message: z.string().optional()});

function isLoopback(hostname: string): boolean {
	return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

/**
 * The origin `--url` names. A password only goes over HTTPS, or plain HTTP to this machine, as
 * a server in development is.
 */
export function parseOrigin(url: string): Result<string, CliError> {
	if (!URL.canParse(url)) {
		return Err(
			CliErr.usage(
				`${url} is not an address: give the one Personal Agent Proxy is opened at, such as https://proxy.example.com`,
			),
		);
	}
	const parsed = new URL(url);
	if (
		parsed.protocol === 'https:' ||
		(parsed.protocol === 'http:' && isLoopback(parsed.hostname))
	) {
		return Ok(parsed.origin);
	}
	return Err(
		CliErr.usage(
			`${url} is not HTTPS: the password only goes over HTTPS, or plain HTTP to this machine`,
		),
	);
}

function fetchFailed(origin: string, error: FetchError): CliError {
	if (error.kind === 'timeout') {
		return CliErr.failed(`${origin} didn't answer within ${error.timeoutMs / 1000} seconds`);
	}
	return CliErr.failed(`${origin} could not be reached`);
}

async function send(
	origin: string,
	path: string,
	init: RequestInit,
): Promise<Result<Answer, CliError>> {
	return Do(async ($) => {
		const response = $(
			(
				await httpRequest(
					`${origin}${path}`,
					{...init, redirect: 'manual'},
					{parse: 'response', allowStatus: () => true, timeoutMs: TIMEOUT_MS},
				)
			).mapErr((error) => fetchFailed(origin, error)),
		);
		if (response.status >= 300 && response.status < 400) {
			const location = response.headers.get('location') ?? 'elsewhere';
			return $(
				Err(
					CliErr.failed(
						`${origin} answered with a redirect to ${location}, which isn't followed: log in with --url set to the address Personal Agent Proxy is opened at`,
					),
				),
			);
		}
		const text = $(
			(await Result.wrapAsync(() => response.text())).mapErr(() =>
				CliErr.failed(`${origin}'s answer could not be read`),
			),
		);
		if (text === '') {
			return {status: response.status, body: null, response};
		}
		const json = z
			.json()
			.safeParse(
				$(
					Result.wrap((): unknown => JSON.parse(text)).mapErr(() =>
						CliErr.failed(
							`${origin} answered with something other than JSON: is --url Personal Agent Proxy?`,
						),
					),
				),
			);
		return {status: response.status, body: json.success ? json.data : null, response};
	});
}

// What a refusal says, in words for whoever ran the command: the api's own message where it has
// one, such as a param a tool doesn't take.
function refusal(answer: Answer, signingIn: boolean): CliError {
	const parsed = errorBodySchema.safeParse(answer.body);
	const error = parsed.success ? parsed.data : null;
	if (error?.error === 'forbidden_origin') {
		return CliErr.failed(
			'The server turned down where the request came from: log in again with --url set to exactly the address Personal Agent Proxy is opened at, its APP_URL',
		);
	}
	if (error?.message) {
		return CliErr.failed(error.message);
	}
	if (answer.status === 401) {
		return CliErr.failed(
			signingIn
				? 'Wrong username or password'
				: 'Not signed in, or the session has ended: run proxy login again',
		);
	}
	if (answer.status === 403) {
		return CliErr.failed(
			signingIn
				? 'This login has been revoked'
				: 'This login may not do that: proxy tools lists what it may do, and the person who made it can give it more',
		);
	}
	if (answer.status === 404) {
		return CliErr.failed(
			'Not found: proxy connections lists the connections, proxy tools <connectionId> their tools',
		);
	}
	if (answer.status === 422) {
		return CliErr.failed(
			'The provider turned this connection’s sign-in down: the person who made this login needs to reconnect it',
		);
	}
	if (answer.status === 502) {
		return CliErr.failed('The provider could not be reached. Try again in a moment');
	}
	return CliErr.failed(`The server answered ${answer.status}${error ? ` (${error.error})` : ''}`);
}

function parseAnswer<S extends z.ZodType>(answer: Answer, schema: S): Result<z.infer<S>, CliError> {
	const parsed = schema.safeParse(answer.body);
	if (!parsed.success) {
		return Err(
			CliErr.failed(
				'The server answered with something unexpected: is it a Personal Agent Proxy of the same version?',
			),
		);
	}
	return Ok(parsed.data);
}

// The agent's session from the cookie the server set, and when it ends.
function sessionFrom(origin: string, response: Response): Result<Session, CliError> {
	const names: string[] = [agentSessionCookieNames.secure, agentSessionCookieNames.insecure];
	for (const header of response.headers.getSetCookie()) {
		const [pair = '', ...attributes] = header.split(';').map((part) => part.trim());
		const equals = pair.indexOf('=');
		const name = pair.slice(0, equals);
		if (equals === -1 || !names.includes(name)) {
			continue;
		}
		const expiresAttribute = attributes.find((attribute) =>
			attribute.toLowerCase().startsWith('expires='),
		);
		const expires = expiresAttribute ? new Date(expiresAttribute.slice('expires='.length)) : null;
		if (!expires || Number.isNaN(expires.getTime())) {
			return Err(CliErr.failed('The server signed in without saying when the session ends'));
		}
		return Ok({
			origin,
			cookie: {name, value: pair.slice(equals + 1)},
			expires: expires.toISOString(),
		});
	}
	return Err(CliErr.failed('The server signed in without setting a session cookie'));
}

/** Signs in as an agent login at `origin`, as `parseOrigin` gives it: the session to keep. */
export function login(
	origin: string,
	username: string,
	password: string,
): Promise<Result<Session, CliError>> {
	return Do(async ($) => {
		const answer = $(
			await send(origin, '/agent-auth/login', {
				method: 'POST',
				headers: {...CLIENT_HEADERS, Origin: origin, 'Content-Type': 'application/json'},
				body: JSON.stringify({username, password}),
			}),
		);
		if (answer.status !== 200) {
			return $(Err(refusal(answer, true)));
		}
		return $(sessionFrom(origin, answer.response));
	});
}

function cookieHeader(session: Session): string {
	return `${session.cookie.name}=${session.cookie.value}`;
}

/** Ends the session on the server. */
export function logout(session: Session): Promise<Result<void, CliError>> {
	return Do(async ($) => {
		const answer = $(
			await send(session.origin, '/agent-auth/logout', {
				method: 'POST',
				headers: {...CLIENT_HEADERS, Origin: session.origin, Cookie: cookieHeader(session)},
			}),
		);
		if (answer.status !== 200) {
			return $(Err(refusal(answer, false)));
		}
	});
}

// A request as the signed-in agent: its answer as JSON, both as the server sent it and as `schema` reads it.
function call<S extends z.ZodType>(
	session: Session,
	path: string,
	schema: S,
	body?: Params,
): Promise<Result<{raw: JsonValue; value: z.infer<S>}, CliError>> {
	const headers = {...CLIENT_HEADERS, Cookie: cookieHeader(session)};
	const init: RequestInit =
		body === undefined
			? {method: 'GET', headers}
			: {
					method: 'POST',
					headers: {...headers, Origin: session.origin, 'Content-Type': 'application/json'},
					body: JSON.stringify({params: body}),
				};
	return Do(async ($) => {
		const answer = $(await send(session.origin, path, init));
		if (answer.status !== 200) {
			return $(Err(refusal(answer, false)));
		}
		return {raw: answer.body, value: $(parseAnswer(answer, schema))};
	});
}

/** Who the agent is, and what it can do with each connection it can use. */
export function getMe(session: Session) {
	return call(session, '/api/agent/me', meSchema);
}

/** The tools the agent has with a connection. */
export function getTools(session: Session, connectionId: string) {
	return call(
		session,
		`/api/agent/connections/${encodeURIComponent(connectionId)}/tools`,
		toolsSchema,
	);
}

/** Runs a tool with its params, checked and logged by the server like any other run. */
export function runTool(session: Session, connectionId: string, tool: string, params: Params) {
	return call(
		session,
		`/api/agent/connections/${encodeURIComponent(connectionId)}/tools/${encodeURIComponent(tool)}`,
		toolResultSchema,
		params,
	);
}
