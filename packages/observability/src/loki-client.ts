import type {Result} from 'ts-results-es';
import {z} from 'zod';

import {type FetchError, httpRequest} from '@proxy/utils';

/** Grafana Cloud Loki: the stack's Loki address, its numeric user id, and an access token. */
export interface LokiConfig {
	url: string;
	userId: string;
	token: string;
}

const lokiStreamSchema = z.object({
	stream: z.record(z.string(), z.string()),
	// Pairs of a timestamp in nanoseconds since the epoch, as a string, and the line.
	values: z.array(z.tuple([z.string(), z.string()])),
});

const lokiMatrixSeriesSchema = z.object({
	metric: z.record(z.string(), z.string()),
	values: z.array(z.tuple([z.number(), z.string()])),
});

const lokiVectorPointSchema = z.object({
	metric: z.record(z.string(), z.string()),
	value: z.tuple([z.number(), z.string()]),
});

const lokiQueryResultSchema = z.object({
	status: z.string(),
	data: z.discriminatedUnion('resultType', [
		z.object({resultType: z.literal('streams'), result: z.array(lokiStreamSchema)}),
		z.object({resultType: z.literal('matrix'), result: z.array(lokiMatrixSeriesSchema)}),
		z.object({resultType: z.literal('vector'), result: z.array(lokiVectorPointSchema)}),
		z.object({resultType: z.literal('scalar'), result: z.tuple([z.number(), z.string()])}),
	]),
});

export type LokiStream = z.infer<typeof lokiStreamSchema>;
export type LokiMatrixSeries = z.infer<typeof lokiMatrixSeriesSchema>;
export type LokiVectorPoint = z.infer<typeof lokiVectorPointSchema>;
export type LokiQueryResult = z.infer<typeof lokiQueryResultSchema>;

export interface LokiPushPayload {
	streams: LokiStream[];
}

export interface LokiQueryParams {
	query: string;
	startNs?: bigint;
	endNs?: bigint;
	limit?: number;
	direction?: 'forward' | 'backward';
}

function authHeader(config: LokiConfig): string {
	return `Basic ${btoa(`${config.userId}:${config.token}`)}`;
}

export function pushLoki(
	config: LokiConfig,
	payload: LokiPushPayload,
): Promise<Result<void, FetchError>> {
	return httpRequest(
		`${config.url}/loki/api/v1/push`,
		{
			method: 'POST',
			headers: {'Content-Type': 'application/json', Authorization: authHeader(config)},
			body: JSON.stringify(payload),
		},
		{timeoutMs: 10_000},
	);
}

export function queryLokiRange(
	config: LokiConfig,
	params: LokiQueryParams,
): Promise<Result<LokiQueryResult, FetchError>> {
	const search = new URLSearchParams();
	search.set('query', params.query);
	if (params.startNs !== undefined) {
		search.set('start', params.startNs.toString());
	}
	if (params.endNs !== undefined) {
		search.set('end', params.endNs.toString());
	}
	if (params.limit !== undefined) {
		search.set('limit', params.limit.toString());
	}
	if (params.direction !== undefined) {
		search.set('direction', params.direction);
	}

	return httpRequest(
		`${config.url}/loki/api/v1/query_range?${search.toString()}`,
		{method: 'GET', headers: {Authorization: authHeader(config)}},
		{schema: lokiQueryResultSchema, timeoutMs: 30_000},
	);
}
