import {setTimeZone} from '@/client/me-client';
import {browserTimeZone} from '@/lib/time-zone';

// The person's own time zone, kept on their account: agents tell time by it, and repeating alerts
// keep to it.

/** Every time zone this browser knows, by its IANA name, with the one given among them where it doesn't know it. */
export function timeZones(current: string | null): string[] {
	const known = Intl.supportedValuesOf('timeZone');
	if (current === null || known.includes(current)) {
		return known;
	}
	return [current, ...known].toSorted();
}

// Whether this page is setting the time zone already, so that the guard, which loads on every
// page, sets it once.
let settingFromBrowser = false;

/**
 * Sets the person's time zone to this browser's where none is set yet, quietly and once, with
 * `save`; the Account page changes it. What fails is tried again on the next page load.
 */
export function rememberBrowserTimeZone(
	timeZone: string | null,
	save: typeof setTimeZone = setTimeZone,
): void {
	if (timeZone !== null || settingFromBrowser) {
		return;
	}
	settingFromBrowser = true;
	void save(browserTimeZone()).then((saved) => {
		if (saved.isErr()) {
			settingFromBrowser = false;
		}
	});
}
