import type {Location} from 'react-router';
import {z} from 'zod';

// Where a page was come to from, kept in the router's location state as a link is followed, so
// the page's back arrow returns there rather than to a list it may not have come from: the address
// of the page before, with its own back in turn, so going back twice retraces the way, as from a
// sub-task's page to its task's and from there to the home page as it was.
export type Back = {back: string; then: Back | null};

// A way back further than one that can't be read is none.
const backSchema: z.ZodType<Back> = z.object({
	back: z.string(),
	then: z.lazy(() => backSchema.nullable()).catch(null),
});

/** The way back the state of the page at `location` says, where it says one. */
export function backOf(location: Pick<Location, 'state'>): Back | null {
	const parsed = backSchema.safeParse(location.state);
	return parsed.success ? parsed.data : null;
}

/** The way back for a link followed from the page at `location`: that page, and its own way back. */
export function backFrom(location: Pick<Location, 'pathname' | 'search' | 'state'>): Back {
	return {back: `${location.pathname}${location.search}`, then: backOf(location)};
}
