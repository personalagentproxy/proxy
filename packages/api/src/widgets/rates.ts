import {Err, Ok, type Result} from 'ts-results-es';
import {z} from 'zod';

import {ApiErr, type ApiError, httpRequest} from '@proxy/utils';
import type {DayRates} from '@proxy/contracts/widgets';

/**
 * The day's exchange rates for Convert units: the European Central Bank's, from Frankfurter, which
 * takes no key and is asked nothing of anyone's. The bank publishes once a working day, so the
 * rates are kept an hour, for every person alike.
 */

const RATES_URL = 'https://api.frankfurter.dev/v1/latest';

const KEEP_MS = 3_600_000;

const answerSchema = z.object({base: z.literal('EUR'), date: z.string(), rates: z.record(z.string(), z.number())});

let kept: {at: number; rates: DayRates} | null = null;

/** `GET /api/widgets/rates`. */
export async function handleRatesRoute(): Promise<Result<DayRates, ApiError>> {
	if (kept && Date.now() - kept.at < KEEP_MS) {
		return Ok(kept.rates);
	}
	const answered = await httpRequest(RATES_URL, {method: 'GET'}, {schema: answerSchema, timeoutMs: 5000});
	if (answered.isErr()) {
		return Err(ApiErr.providerUnreachable(answered.error));
	}
	const rates = {date: answered.value.date, rates: {EUR: 1, ...answered.value.rates}};
	kept = {at: Date.now(), rates};
	return Ok(rates);
}
