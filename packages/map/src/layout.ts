import dagre from '@dagrejs/dagre';
import type {Edge, Screen} from './map-schema';

// A card's size, as the layout counts it; the node measures itself once it renders.
export const NODE_WIDTH = 320;
export const NODE_HEIGHT = 280;

// The edges that shape the layout: a tree from the sign-in page, and from any screen nothing
// leads to, each screen under the first one found leading to it, by a link or a button before
// the sidebar. The rest, the ways back (Back, Cancel, Delete) among them, are drawn but do not
// pull screens around.
const START = '/login';

function treeEdges(screens: Screen[], edges: Edge[]): Edge[] {
	const ordered = [...edges].sort((a, b) => Number(a.kind === 'nav') - Number(b.kind === 'nav'));
	const ledTo = new Set(edges.map((edge) => edge.to));
	const roots = screens
		.filter((screen) => screen.path === START || !ledTo.has(screen.path))
		.map((screen) => screen.path);
	const seen = new Set(roots);
	const queue = [...roots];
	const tree: Edge[] = [];
	while (queue.length > 0) {
		const from = queue.shift();
		for (const edge of ordered) {
			if (edge.from !== from || seen.has(edge.to)) {
				continue;
			}
			seen.add(edge.to);
			queue.push(edge.to);
			tree.push(edge);
		}
	}
	return tree;
}

export function layoutScreens(
	screens: Screen[],
	edges: Edge[],
): Map<string, {x: number; y: number}> {
	const graph = new dagre.graphlib.Graph();
	graph.setGraph({rankdir: 'TB', nodesep: 40, ranksep: 100});
	graph.setDefaultEdgeLabel(() => ({}));
	for (const screen of screens) {
		graph.setNode(screen.path, {width: NODE_WIDTH, height: NODE_HEIGHT});
	}
	for (const edge of treeEdges(screens, edges)) {
		graph.setEdge(edge.from, edge.to);
	}
	dagre.layout(graph);

	const positions = new Map<string, {x: number; y: number}>();
	for (const screen of screens) {
		const node = graph.node(screen.path);
		// dagre gives centres; React Flow takes the top-left corner.
		positions.set(screen.path, {x: node.x - NODE_WIDTH / 2, y: node.y - NODE_HEIGHT / 2});
	}
	return positions;
}
