import {Err, Ok, type Result} from 'ts-results-es';
import {Frequency, type Options, RRule} from 'rrule';

/**
 * How a timed alert that opens new threads repeats: an RFC 5545 RRULE, such as
 * `FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0`, read on the wall clock of the member's time zone, so
 * that "Mondays at 9" stays at 9 across a change to or from summer time. The rule is worked out in
 * that zone's wall clock, written as if it were UTC (what the rrule package reads a date as), and
 * each time it gives is turned back into the moment it is in the zone. The first time is the
 * alert's `at`; each after it is the rule's next after the one that fired, or after now where the
 * sweep was down meanwhile, so a missed one is skipped rather than made up.
 */

// The least while between two times a rule may give: an alert is no clock.
const MIN_GAP_MS = 60 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The time zone a rule is read in where the member has none set. */
export const DEFAULT_TIME_ZONE = 'UTC';

/** Whether the zone is one the server knows by its IANA name. */
export function isTimeZone(timeZone: string): boolean {
	try {
		new Intl.DateTimeFormat('en-US', {timeZone});
		return true;
	} catch {
		return false;
	}
}

// How far the zone's wall clock is ahead of UTC at the moment `ms`, in milliseconds.
function offsetAt(timeZone: string, ms: number): number {
	const parts = new Intl.DateTimeFormat('en-US', {
		timeZone,
		hourCycle: 'h23',
		year: 'numeric',
		month: 'numeric',
		day: 'numeric',
		hour: 'numeric',
		minute: 'numeric',
		second: 'numeric',
	}).formatToParts(new Date(ms));
	const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((candidate) => candidate.type === type)?.value ?? 0);
	const wall = Date.UTC(part('year'), part('month') - 1, part('day'), part('hour'), part('minute'), part('second'));
	return wall - (ms - (((ms % 1000) + 1000) % 1000));
}

// The zone's wall clock at the moment, written as if it were UTC.
function wallOf(moment: Date, timeZone: string): Date {
	return new Date(moment.getTime() + offsetAt(timeZone, moment.getTime()));
}

// The moment the zone's wall clock, written as if it were UTC, reads: of the zone's offsets a day
// either side, the one that reads it; the first where both do, as the clocks go back; and, a wall
// time skipped as they go forward, the offset from before, which puts it as far past the gap.
function momentOf(wall: Date, timeZone: string): Date {
	const ms = wall.getTime();
	const before = ms - offsetAt(timeZone, ms - DAY_MS);
	const after = ms - offsetAt(timeZone, ms + DAY_MS);
	const reads = [before, after].filter((moment) => wallOf(new Date(moment), timeZone).getTime() === ms);
	if (reads.length === 0) {
		return new Date(before);
	}
	return new Date(Math.min(...reads));
}

// The rule's options, read from what the agent gave: an RRULE line, with or without its name.
function ruleOptions(rule: string): Result<Partial<Options>, string> {
	const line = rule.trim().replace(/^RRULE:/i, '');
	let options: Partial<Options>;
	try {
		options = RRule.parseString(line);
	} catch (error) {
		return Err(`every is not an RRULE: ${error instanceof Error ? error.message : String(error)}.`);
	}
	if (options.freq === undefined) {
		return Err('every needs a FREQ, such as FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0.');
	}
	if (options.dtstart || options.tzid) {
		return Err('Give every without DTSTART or TZID: the first time is at, and the time zone is the person’s.');
	}
	if (options.freq === Frequency.MINUTELY || options.freq === Frequency.SECONDLY) {
		return Err('every repeats too often: an hour apart at the least.');
	}
	return Ok(options);
}

// The rule as it runs from `at`, on the zone's wall clock.
function ruleFrom(options: Partial<Options>, at: Date, timeZone: string): RRule {
	return new RRule({...options, dtstart: wallOf(at, timeZone)});
}

/**
 * The rule checked, from its first time `at` in `timeZone`: a rule the package reads, without a
 * start or a zone of its own, that comes again after `at`, at least an hour apart. `Ok` with the
 * rule as kept, its line without the RRULE name; `Err` says what is wrong, for the model.
 */
export function checkEvery(rule: string, at: Date, timeZone: string): Result<string, string> {
	const options = ruleOptions(rule);
	if (options.isErr()) {
		return options;
	}
	const run = ruleFrom(options.value, at, timeZone);
	const [first, second] = run.all((_, index) => index < 2);
	if (first === undefined) {
		return Err('every never comes from at.');
	}
	if (second !== undefined && second.getTime() - first.getTime() < MIN_GAP_MS) {
		return Err('every repeats too often: an hour apart at the least.');
	}
	return Ok(RRule.optionsToString(options.value).replace(/^RRULE:/, ''));
}

/** The next time the alert repeating by `every` from `at`, in `timeZone`, comes after `after`; null where it comes no more. */
export function nextTime(alert: {at: Date; every: string; timeZone: string}, after: Date): Date | null {
	const options = ruleOptions(alert.every);
	if (options.isErr()) {
		return null;
	}
	const next = ruleFrom(options.value, alert.at, alert.timeZone).after(wallOf(after, alert.timeZone), false);
	return next === null ? null : momentOf(next, alert.timeZone);
}

/** How the alert repeats, in words, with the zone it keeps to: "every week on Monday at 9 (Europe/Berlin)". */
export function everyText(every: string, timeZone: string): string {
	const options = ruleOptions(every);
	if (options.isErr()) {
		return every;
	}
	return `${new RRule(options.value).toText()} (${timeZone})`;
}
