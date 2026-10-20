// The time zone the browser counts days in, as the home page's widgets do.
export function browserTimeZone(): string {
	return Intl.DateTimeFormat().resolvedOptions().timeZone;
}
