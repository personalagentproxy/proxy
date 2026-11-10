import type {ShouldRevalidateFunctionArgs} from 'react-router';

/** One part of a page: its id in the address, what its tab says, and a count beside that where it lists things. */
export type PageTab<T extends string> = {id: T; label: string; count?: number};

/**
 * Which of a page's parts is shown, from its address's query: the one it names (`?tab=<id>`), or
 * the first where it names none, or one the page doesn't have.
 */
export function chosenTab<T extends string>(
	tabs: Array<PageTab<T>>,
	params: URLSearchParams,
): T | null {
	const named = tabs.find((tab) => tab.id === params.get('tab'));
	return named?.id ?? tabs[0]?.id ?? null;
}

/**
 * For the route of a page with tabs: a change of the tab alone shows another part of what the
 * page has loaded already, so it doesn't load the page again.
 */
export function shouldRevalidateTabs({
	currentUrl,
	nextUrl,
	defaultShouldRevalidate,
}: ShouldRevalidateFunctionArgs): boolean {
	if (currentUrl.pathname !== nextUrl.pathname || currentUrl.search === nextUrl.search) {
		return defaultShouldRevalidate;
	}
	const withoutTab = (url: URL) => {
		const params = new URLSearchParams(url.search);
		params.delete('tab');
		return params.toString();
	};
	if (withoutTab(currentUrl) !== withoutTab(nextUrl)) {
		return defaultShouldRevalidate;
	}
	return false;
}
