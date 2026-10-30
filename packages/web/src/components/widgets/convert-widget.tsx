import {findUnit, UNITS, convert, type Rates, type Unit} from '@proxy/utils/units';
import {ArrowRightLeftIcon} from 'lucide-react';
import type {Intent} from '@/client/intent-client';
import {CopyButton} from '@/components/copy-button';
import {Missing, WidgetFrame} from '@/components/widgets/widget-frame';
import {formatNumber} from '@/lib/calculate';
import {useRates} from '@/hooks/widget-lookups';
import {fieldTexts} from '@/lib/widget-values';

// The other units of a kind shown under the answer, at most, and the amounts they read well at:
// 5 miles is 8,046.72 m, not 8,046,720 mm.
const ALSO = 4;
const READABLE = {from: 0.01, to: 100_000};

// The currencies shown under a conversion of money, those of them it isn't already in.
const ALSO_MONEY = ['usd', 'eur', 'gbp', 'jpy', 'chf', 'cad'];

// A conversion's significant digits: 72 °F is 22.2222 °C.
const DIGITS = 6;

const DAY = new Intl.DateTimeFormat(undefined, {month: 'short', day: 'numeric'});

// An amount as the answer reads, "8.04672 kilometres", or as the others under it do, "8,046.72
// m". A temperature is always its symbol, "22.2222 °C", and money its currency's, "€50.02".
function amountOf(value: number, unit: Unit, short = false): string {
	if (unit.kind === 'currency') {
		return new Intl.NumberFormat(undefined, {style: 'currency', currency: unit.symbol}).format(
			value,
		);
	}
	if (short || unit.kind === 'temperature') {
		return `${formatNumber(value, DIGITS)} ${unit.symbol}`;
	}
	return `${formatNumber(value, DIGITS)} ${value === 1 ? unit.name : unit.plural}`;
}

// The same amount in a few other units of its kind, each where it reads well.
function othersOf(amount: number, from: Unit, to: Unit, rates: Rates | undefined) {
	const candidates =
		from.kind === 'currency'
			? ALSO_MONEY.flatMap((id) => findUnit(id) ?? [])
			: UNITS.filter((unit) => unit.kind === from.kind);
	return candidates
		.flatMap((unit) => {
			const value =
				unit.id === from.id || unit.id === to.id ? null : convert(amount, from, unit, rates);
			const readable =
				value !== null &&
				(from.kind === 'currency' ||
					(Math.abs(value) >= READABLE.from && Math.abs(value) <= READABLE.to));
			return readable ? [{unit, value}] : [];
		})
		.slice(0, ALSO);
}

// Convert units: the amount in the unit asked for, or, where none was, its metric or imperial
// counterpart (a dollar's the euro, other money's the dollar), with the same in a few other units of
// its kind. Money is at the European Central Bank's rates of the day.
export function ConvertWidget({intent}: {intent: Intent}) {
	const [amountText] = fieldTexts(intent, 'amount');
	const from = findUnit(fieldTexts(intent, 'fromUnit')[0] ?? '');
	const asked = findUnit(fieldTexts(intent, 'toUnit')[0] ?? '');
	const to =
		asked && asked.kind === from?.kind && asked.id !== from.id
			? asked
			: from && findUnit(from.counterpart);
	const money = from?.kind === 'currency';
	const rates = useRates(money ? true : null);
	const amount = amountText === undefined ? 1 : Number(amountText.replace(/,/g, ''));
	const result =
		from && to && Number.isFinite(amount) ? convert(amount, from, to, rates.data?.rates) : null;

	return (
		<WidgetFrame icon={ArrowRightLeftIcon} name="Convert units">
			{!from && <Missing>Type an amount and its unit, such as 5 miles in km</Missing>}
			{money && result === null && (
				<Missing>
					{rates.error ? 'Today’s exchange rates couldn’t be fetched' : 'Fetching today’s rates…'}
				</Missing>
			)}
			{from && to && result !== null && (
				<>
					<div className="flex items-end justify-between gap-3">
						<div className="min-w-0">
							<p className="truncate text-muted-foreground">{amountOf(amount, from)} =</p>
							<p className="truncate text-2xl font-medium tabular-nums" aria-label="Result">
								{amountOf(result, to)}
							</p>
						</div>
						<CopyButton
							value={money ? result.toFixed(2) : String(Number(result.toPrecision(DIGITS)))}
							label="Copy result"
						/>
					</div>
					<Others amount={amount} from={from} to={to} rates={rates.data?.rates} />
					{money && rates.data && (
						<p className="text-muted-foreground">
							European Central Bank rates of {DAY.format(new Date(`${rates.data.date}T00:00`))}
						</p>
					)}
				</>
			)}
		</WidgetFrame>
	);
}

function Others({amount, from, to, rates}: {amount: number; from: Unit; to: Unit; rates?: Rates}) {
	const others = othersOf(amount, from, to, rates);
	if (others.length === 0) {
		return null;
	}
	return (
		<p className="flex flex-wrap gap-x-4 text-muted-foreground tabular-nums" aria-label="Also">
			{others.map(({unit, value}) => (
				<span key={unit.id}>{amountOf(value, unit, true)}</span>
			))}
		</p>
	);
}
