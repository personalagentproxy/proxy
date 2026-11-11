// The time zone the browser counts days in, as the command bar's widgets do.
export function browserTimeZone(): string {
	return Intl.DateTimeFormat().resolvedOptions().timeZone;
}
