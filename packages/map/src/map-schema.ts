import {z} from 'zod';

// `generated/map.json`, what the crawl writes and the page reads.

// How a screen leads to another: `link`, an anchor on the page; `nav`, an anchor in the sidebar
// or header, on every page of its side; `button`, a navigation after a click or a submit, which
// the crawl cannot see and `button-edges.ts` lists by hand.
export const EDGE_KINDS = ['link', 'nav', 'button'] as const;

export type EdgeKind = (typeof EDGE_KINDS)[number];

const screenSchema = z.object({
	// The route's pattern, such as `/agents/:id`: the screen's id.
	path: z.string(),
	// The address the crawl visited, null where it found no way to the screen.
	url: z.string().nullable(),
	// The screenshot's file name under `generated/`, null without one.
	screenshot: z.string().nullable(),
});

export type Screen = z.infer<typeof screenSchema>;

const edgeSchema = z.object({
	from: z.string(),
	to: z.string(),
	// The anchor's text; null where several anchors with different texts lead the same way, as
	// the rows of a list do.
	label: z.string().nullable(),
	kind: z.enum(EDGE_KINDS),
});

export type Edge = z.infer<typeof edgeSchema>;

export const mapSchema = z.object({
	generatedAt: z.string(),
	viewport: z.object({width: z.number(), height: z.number()}),
	screens: z.array(screenSchema),
	edges: z.array(edgeSchema),
});

export type ScreenMap = z.infer<typeof mapSchema>;
