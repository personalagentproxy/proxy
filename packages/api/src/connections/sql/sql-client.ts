import {SQL} from 'bun';
import {Err, Result} from 'ts-results-es';

import {ApiErr, type ApiError} from '@proxy/utils';

import {resolveHost} from '../../utils/host-check';
import type {SqlCredential, SqlDialect} from './credential';

/**
 * How Personal Agent Proxy speaks to a database: one connection per request, opened to the
 * address the host resolves to (`resolveHost`), encrypted as the connection says, and closed when
 * the request is done. Every statement runs on that one connection, in order, so a transaction's
 * statements stay together.
 */

const CONNECT_TIMEOUT_S = 10;

/** What a statement answered: its rows, how many rows it changed, and the id an insert made. */
export type SqlResult = {rows: Record<string, unknown>[]; affected: number; lastInsertId: string | null};

/** Runs one statement, its params in the dialect's placeholders (`$1`, `?`). */
export type SqlRun = (statement: string, params?: unknown[]) => Promise<Result<SqlResult, ApiError>>;

// The fields Bun puts beside a result's rows.
type BunResult = Record<string, unknown>[] & {count?: number; affectedRows?: number; lastInsertRowid?: number | bigint};

function toResult(answer: BunResult): SqlResult {
	const rows = answer.length > 0 && Array.isArray(answer[0]) ? [] : [...answer];
	const lastInsertId = answer.lastInsertRowid !== undefined && answer.lastInsertRowid !== 0 && answer.lastInsertRowid !== 0n ? String(answer.lastInsertRowid) : null;
	return {rows, affected: answer.affectedRows ?? answer.count ?? 0, lastInsertId};
}

type ServerError = {name: string; code: string | null; errno: string | number | null; message: string};

function serverError(error: unknown): ServerError | null {
	if (!(error instanceof Error)) {
		return null;
	}
	const {code, errno} = error as Error & {code?: unknown; errno?: unknown};
	return {
		name: error.name,
		code: typeof code === 'string' ? code : null,
		errno: typeof errno === 'string' || typeof errno === 'number' ? errno : null,
		message: error.message,
	};
}

/**
 * What a failed statement means: the user turned down, the server out of reach (a wrong port, TLS
 * that didn't verify, a timeout), or the server refusing the statement, whose own words go on to
 * the agent: a table that doesn't exist, a value a column doesn't take.
 */
export function sqlError(error: unknown): ApiError {
	const failed = serverError(error);
	if (!failed) {
		return ApiErr.providerUnreachable(error);
	}
	if (failed.name === 'PostgresError') {
		// errno is the SQLSTATE: class 28 is a failed sign-in, class 08 a lost connection.
		const state = String(failed.errno ?? '');
		if (state.startsWith('28')) {
			return ApiErr.credentialsRejected();
		}
		if (state.startsWith('08') || failed.code?.startsWith('ERR_POSTGRES_CONNECTION')) {
			return ApiErr.providerUnreachable(error);
		}
		return ApiErr.validationError(failed.message);
	}
	if (failed.name === 'MySQLError') {
		if (failed.errno === 1045) {
			return ApiErr.credentialsRejected();
		}
		if (failed.code?.startsWith('ERR_MYSQL_CONNECTION')) {
			return ApiErr.providerUnreachable(error);
		}
		return ApiErr.validationError(failed.message);
	}
	return ApiErr.providerUnreachable(error);
}

// The server's certificate is checked against the typed-in host, since the connection goes to its
// address; `require` encrypts without checking it, as a self-signed one needs.
function tlsOptions(credential: SqlCredential): Bun.TLSOptions | false {
	if (credential.tls === 'off') {
		return false;
	}
	return {serverName: credential.host, rejectUnauthorized: credential.tls === 'verify'};
}

// `postgres://user:pass@203.0.113.5:5432/app`, each part escaped, an IPv6 address in brackets.
function connectionUrl(dialect: SqlDialect, credential: SqlCredential, address: string): string {
	const host = address.includes(':') ? `[${address}]` : address;
	return `${dialect}://${encodeURIComponent(credential.username)}:${encodeURIComponent(credential.password)}@${host}:${credential.port}/${encodeURIComponent(credential.database)}`;
}

/**
 * Opens a connection to the database and runs `fn` with it, closing it after. The host is
 * resolved and checked first; a private address is refused unless `ALLOW_PRIVATE_HOSTS` says
 * otherwise.
 */
export async function withSql<T>(dialect: SqlDialect, credential: SqlCredential, fn: (run: SqlRun) => Promise<Result<T, ApiError>>): Promise<Result<T, ApiError>> {
	const address = await resolveHost(credential.host);
	if (address.isErr()) {
		return address;
	}
	const sql = new SQL({
		// The URL as well as its parts: given only the parts, Bun fills the rest in from the api's own
		// DATABASE_URL, whose query parameters would go to the agent's database.
		url: connectionUrl(dialect, credential, address.value),
		adapter: dialect,
		hostname: address.value,
		port: credential.port,
		database: credential.database,
		username: credential.username,
		password: credential.password,
		tls: tlsOptions(credential),
		max: 1,
		connectionTimeout: CONNECT_TIMEOUT_S,
	});
	const reserved = await Result.wrapAsync(() => sql.reserve());
	if (reserved.isErr()) {
		await sql.close({timeout: 1}).catch(() => undefined);
		return Err(sqlError(reserved.error));
	}
	const run: SqlRun = async (statement, params = []) => {
		const answer = await Result.wrapAsync(() => reserved.value.unsafe(statement, params) as Promise<BunResult>);
		return answer.map(toResult).mapErr(sqlError);
	};
	const outcome = await fn(run);
	reserved.value.release();
	await sql.close({timeout: 1}).catch(() => undefined);
	return outcome;
}

/** Signs in to the database and runs nothing else: what connecting checks first. */
export function checkDatabase(dialect: SqlDialect, credential: SqlCredential): Promise<Result<void, ApiError>> {
	return withSql(dialect, credential, async (run) => (await run('SELECT 1')).map(() => undefined));
}
