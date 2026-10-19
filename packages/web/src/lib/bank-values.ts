import * as chrono from 'chrono-node';
import {Result} from 'ts-results-es';
import {addDays, daysBetween, dayIn} from '@proxy/utils/days';
import type {BankAccount, BankTransaction, DayRange} from '@/client/widgets-client';
import {browserTimeZone} from '@/lib/activity-graph';

// What the Balances and Transactions widgets make of what was typed: the days asked about, the
// accounts a name stands for, the transactions that match, and what they add up to.

// How far back a search goes when no days are said.
const DEFAULT_DAYS = 30;

/** The days asked about, as the widget reads and names them: "last month", "September", "the last 30 days". */
export type AskedRange = DayRange & {said: string; defaulted: boolean};

const MONTH = new Intl.DateTimeFormat('en-US', {month: 'long'});
const SHORT_DAY = new Intl.DateTimeFormat('en-US', {month: 'short', day: 'numeric'});
const SHORT_DAY_YEAR = new Intl.DateTimeFormat('en-US', {
	month: 'short',
	day: 'numeric',
	year: 'numeric',
});

function localDay(date: Date): string {
	return dayIn(date, browserTimeZone());
}

function dayOf(day: string): Date {
	return new Date(`${day}T00:00`);
}

// The first and last day of the month a day is in.
function monthOf(day: string): DayRange {
	const date = dayOf(day);
	const first = new Date(date.getFullYear(), date.getMonth(), 1);
	const last = new Date(date.getFullYear(), date.getMonth() + 1, 0);
	return {from: localDay(first), to: localDay(last)};
}

function yearOf(year: number): DayRange {
	return {from: `${year}-01-01`, to: `${year}-12-31`};
}

// The Monday a day's week starts on.
function mondayOf(day: string): string {
	const weekday = (dayOf(day).getDay() + 6) % 7;
	return addDays(day, -weekday);
}

const COUNT_WORDS: Record<string, number> = {
	a: 1,
	an: 1,
	one: 1,
	two: 2,
	three: 3,
	four: 4,
	five: 5,
	six: 6,
	seven: 7,
	eight: 8,
	nine: 9,
	ten: 10,
	twelve: 12,
};

function countOf(word: string): number {
	return COUNT_WORDS[word.toLowerCase()] ?? Number(word);
}

// "the last 30 days", "past two weeks", "last 3 months", "the past week": that long, up to today.
// "Last week" and "last month" alone, the calendar's, are read before this.
const LAST_SOME =
	/\b(?:last|past|previous)\s+(?:(\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten|twelve)\s+)?(days?|weeks?|months?|years?)\b/i;

function lastSome(typed: string, today: string): AskedRange | null {
	const match = LAST_SOME.exec(typed);
	if (!match) {
		return null;
	}
	const count = countOf(match[1] ?? '1');
	const unit = (match[2] ?? 'days').toLowerCase();
	if (!Number.isFinite(count) || count <= 0) {
		return null;
	}
	const date = dayOf(today);
	if (unit.startsWith('day')) {
		return {
			from: addDays(today, -(count - 1)),
			to: today,
			said: `the last ${count} days`,
			defaulted: false,
		};
	}
	if (unit.startsWith('week')) {
		return {
			from: addDays(today, -(count * 7 - 1)),
			to: today,
			said: count === 1 ? 'the last week' : `the last ${count} weeks`,
			defaulted: false,
		};
	}
	if (unit.startsWith('month')) {
		date.setMonth(date.getMonth() - count);
		return {
			from: addDays(localDay(date), 1),
			to: today,
			said: count === 1 ? 'the last month' : `the last ${count} months`,
			defaulted: false,
		};
	}
	date.setFullYear(date.getFullYear() - count);
	return {
		from: addDays(localDay(date), 1),
		to: today,
		said: count === 1 ? 'the last year' : `the last ${count} years`,
		defaulted: false,
	};
}

// Days said by name, relative to today.
function namedRange(typed: string, today: string): AskedRange | null {
	const said = (pattern: RegExp) => pattern.test(typed);
	if (said(/\btoday\b/i)) {
		return {from: today, to: today, said: 'today', defaulted: false};
	}
	if (said(/\byesterday\b/i)) {
		const day = addDays(today, -1);
		return {from: day, to: day, said: 'yesterday', defaulted: false};
	}
	if (said(/\bthis week\b/i)) {
		return {from: mondayOf(today), to: today, said: 'this week', defaulted: false};
	}
	if (said(/\blast week\b/i)) {
		const monday = addDays(mondayOf(today), -7);
		return {from: monday, to: addDays(monday, 6), said: 'last week', defaulted: false};
	}
	if (said(/\bthis month\b/i)) {
		return {from: monthOf(today).from, to: today, said: 'this month', defaulted: false};
	}
	if (said(/\blast month\b/i)) {
		const previous = monthOf(addDays(monthOf(today).from, -1));
		return {...previous, said: 'last month', defaulted: false};
	}
	if (said(/\bthis year\b/i)) {
		return {from: `${today.slice(0, 4)}-01-01`, to: today, said: 'this year', defaulted: false};
	}
	if (said(/\blast year\b/i)) {
		return {...yearOf(Number(today.slice(0, 4)) - 1), said: 'last year', defaulted: false};
	}
	return null;
}

// "since october 1", "since monday": from that day to today.
function sinceRange(typed: string, now: Date, today: string): AskedRange | null {
	const match = /\bsince\s+(.+)$/i.exec(typed);
	const [result] = match ? chrono.parse(match[1] ?? '', now) : [];
	if (!result) {
		return null;
	}
	const day = pastOrSame(result, today);
	return {from: day, to: today, said: `since ${SHORT_DAY.format(dayOf(day))}`, defaulted: false};
}

// The day a result names, among those a transaction can be on: "friday" alone is the last one, and a
// month said alone the last one of that name.
function pastOrSame(result: chrono.ParsedResult, today: string): string {
	const {start} = result;
	const day = localDay(start.date());
	if (day <= today) {
		return day;
	}
	if (start.isCertain('weekday') && !start.isCertain('day')) {
		return addDays(day, -7);
	}
	if (start.isCertain('month') && !start.isCertain('year')) {
		const date = dayOf(day);
		date.setFullYear(date.getFullYear() - 1);
		return localDay(date);
	}
	return day;
}

// "in 2025": a year alone, said in digits.
function yearRange(typed: string, today: string): AskedRange | null {
	const match = /\b(20\d\d)\b/.exec(typed);
	if (!match) {
		return null;
	}
	const year = Number(match[1]);
	const range = yearOf(year);
	return {
		from: range.from,
		to: range.to < today ? range.to : today,
		said: String(year),
		defaulted: false,
	};
}

// What chrono reads: two days ("from october 1 to october 15"), a month alone ("in september"), or
// a day ("on friday", "on the 3rd"); never a time of day alone.
function parsedRange(typed: string, now: Date, today: string): AskedRange | null {
	for (const result of chrono.parse(typed, now)) {
		const {start} = result;
		if (
			start.isCertain('hour') &&
			!start.isCertain('day') &&
			!start.isCertain('weekday') &&
			!start.isCertain('month')
		) {
			continue;
		}
		if (result.end) {
			const from = localDay(start.date());
			const to = localDay(result.end.date());
			return {
				from,
				to,
				said: `${SHORT_DAY.format(dayOf(from))} – ${SHORT_DAY.format(dayOf(to))}`,
				defaulted: false,
			};
		}
		if (start.isCertain('month') && !start.isCertain('day') && !start.isCertain('weekday')) {
			const month = monthOf(pastOrSame(result, today));
			const monthName = MONTH.format(dayOf(month.from));
			return {
				from: month.from,
				to: month.to < today ? month.to : today,
				said:
					month.from.slice(0, 4) === today.slice(0, 4)
						? monthName
						: `${monthName} ${month.from.slice(0, 4)}`,
				defaulted: false,
			};
		}
		if (start.isCertain('day') || start.isCertain('weekday')) {
			const day = pastOrSame(result, today);
			return {
				from: day,
				to: day,
				said:
					day.slice(0, 4) === today.slice(0, 4)
						? SHORT_DAY.format(dayOf(day))
						: SHORT_DAY_YEAR.format(dayOf(day)),
				defaulted: false,
			};
		}
	}
	return null;
}

/**
 * The days asked about in what was typed, on the browser's clock: "last month", "this week", "the
 * past 90 days", "in september", "since october 1", "yesterday"; the last 30 days when none are said.
 */
export function rangeAsked(typed: string, now: Date): AskedRange {
	const today = localDay(now);
	const asked =
		namedRange(typed, today) ??
		lastSome(typed, today) ??
		sinceRange(typed, now, today) ??
		parsedRange(typed, now, today) ??
		yearRange(typed, today);
	if (asked) {
		return asked;
	}
	return {
		from: addDays(today, -(DEFAULT_DAYS - 1)),
		to: today,
		said: `the last ${DEFAULT_DAYS} days`,
		defaulted: true,
	};
}

/** The same stretch of days before a range, and what to call it: "the month before", "the 30 days before". */
export function rangeBefore(range: DayRange): DayRange & {said: string} {
	const days = daysBetween(range.from, range.to) + 1;
	const wholeMonths = range.from.endsWith('-01') && monthOf(range.to).to === range.to;
	if (wholeMonths) {
		const months =
			(Number(range.to.slice(0, 4)) - Number(range.from.slice(0, 4))) * 12 +
			Number(range.to.slice(5, 7)) -
			Number(range.from.slice(5, 7)) +
			1;
		const start = dayOf(range.from);
		start.setMonth(start.getMonth() - months);
		return {
			from: localDay(start),
			to: addDays(range.from, -1),
			said:
				months === 12
					? 'the year before'
					: months === 1
						? 'the month before'
						: `the ${months} months before`,
		};
	}
	const to = addDays(range.from, -1);
	return {
		from: addDays(to, -(days - 1)),
		to,
		said:
			days === 1 ? 'the day before' : days === 7 ? 'the week before' : `the ${days} days before`,
	};
}

/** Whether a day is in the range, both ends included. */
export function inRange(day: string, range: DayRange): boolean {
	return day >= range.from && day <= range.to;
}

/** The days as a line reads them: "Oct 1 – Oct 19", or one day. */
export function rangeRead(range: DayRange): string {
	if (range.from === range.to) {
		return SHORT_DAY.format(dayOf(range.from));
	}
	return `${SHORT_DAY.format(dayOf(range.from))} – ${SHORT_DAY.format(dayOf(range.to))}`;
}

function words(text: string): string[] {
	return text
		.toLowerCase()
		.split(/[^\p{L}\p{N}]+/u)
		.filter((word) => word !== '');
}

// What a request says around an account's name, no part of it.
const ACCOUNT_FILLER = new Set([
	'my',
	'the',
	'account',
	'accounts',
	'on',
	'in',
	'from',
	'bank',
	'balance',
	'of',
	'ending',
	'number',
	'with',
]);

// Words that mean a kind of account rather than naming one.
const ACCOUNT_KINDS: Array<[RegExp, (account: BankAccount) => boolean]> = [
	[/^(card|cards|cc|credit)$/, (account) => /credit/i.test(account.type)],
	[/^(checking|current)$/, (account) => /checking/i.test(account.type)],
	[/^(savings?)$/, (account) => /saving/i.test(account.type)],
	[/^(loan|loans|mortgage)$/, (account) => account.owed && !/credit/i.test(account.type)],
];

/**
 * The accounts a name stands for: those whose name, kind or last digits have every word said, "my
 * amex" and "checking" and "the card ending in 3333" alike. None when no account does.
 */
export function matchAccounts(accounts: BankAccount[], said: string | null): BankAccount[] {
	const wanted = words(said ?? '').filter((word) => !ACCOUNT_FILLER.has(word));
	if (wanted.length === 0) {
		return [];
	}
	return accounts.filter((account) => {
		const text = `${account.name} ${account.type} ${account.mask}`.toLowerCase();
		return wanted.every(
			(word) =>
				text.includes(word) ||
				ACCOUNT_KINDS.some(([pattern, is]) => pattern.test(word) && is(account)),
		);
	});
}

export type TransactionFilter = {
	range: DayRange;
	merchant: string | null;
	category: string | null;
	flow: 'in' | 'out' | null;
	/** The accounts to keep to, or null for all. */
	accountIds: string[] | null;
};

/** The transactions of the days, at the merchant, of the kind, in the direction and on the accounts asked. */
export function filterTransactions(
	transactions: BankTransaction[],
	filter: TransactionFilter,
): BankTransaction[] {
	const merchantWords = words(filter.merchant ?? '');
	return transactions.filter((transaction) => {
		if (!inRange(transaction.date, filter.range)) {
			return false;
		}
		if (filter.category && transaction.category !== filter.category) {
			return false;
		}
		if (filter.flow === 'out' && transaction.amount >= 0) {
			return false;
		}
		if (filter.flow === 'in' && transaction.amount <= 0) {
			return false;
		}
		if (filter.accountIds && !filter.accountIds.includes(transaction.accountId)) {
			return false;
		}
		const text = `${transaction.merchant ?? ''} ${transaction.name}`.toLowerCase();
		return merchantWords.every((word) => text.includes(word));
	});
}

/** What transactions add up to in a currency: what went out, what came in, and how many there were. */
export type Total = {currency: string; out: number; in: number; count: number};

/** The totals of the transactions, one per currency, the currency with most transactions first. */
export function totalsOf(transactions: BankTransaction[]): Total[] {
	const totals = new Map<string, Total>();
	for (const transaction of transactions) {
		const total = totals.get(transaction.currency) ?? {
			currency: transaction.currency,
			out: 0,
			in: 0,
			count: 0,
		};
		total.count += 1;
		if (transaction.amount < 0) {
			total.out = cents(total.out - transaction.amount);
		}
		if (transaction.amount > 0) {
			total.in = cents(total.in + transaction.amount);
		}
		totals.set(transaction.currency, total);
	}
	return [...totals.values()].sort((a, b) => b.count - a.count);
}

// A sum without the drift of adding floats: 5.4 + 82.15 is 87.55, not 87.55000000000001.
function cents(amount: number): number {
	return Math.round(amount * 1e8) / 1e8;
}

// The currencies Intl writes with a symbol or its code: a bank's own code for one without an ISO
// code, as a cryptocurrency's, it would write as "BTC 0.00".
const KNOWN_CURRENCIES = new Set(Intl.supportedValuesOf('currency'));

/** An amount in its currency, "$1,234.56", or with the code after it for one Intl doesn't know, "0.00342 BTC". */
export function formatMoney(amount: number, currency: string): string {
	const formatted = KNOWN_CURRENCIES.has(currency.toUpperCase())
		? Result.wrap(() =>
				new Intl.NumberFormat('en-US', {style: 'currency', currency}).format(amount),
			)
		: null;
	if (formatted?.isOk()) {
		return formatted.value;
	}
	return `${amount.toLocaleString('en-US', {useGrouping: false, maximumFractionDigits: 20})} ${currency}`.trim();
}
