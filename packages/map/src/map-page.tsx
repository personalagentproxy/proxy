import {
	Background,
	Controls,
	MarkerType,
	MiniMap,
	Panel,
	ReactFlow,
	useNodesState,
	type Edge as FlowEdge,
	type XYPosition,
} from '@xyflow/react';
import {useEffect, useMemo, useRef, useState} from 'react';
import {Result} from 'ts-results-es';
import {z} from 'zod';
import {Button} from '@proxy/ui/components/button';
import {Checkbox} from '@proxy/ui/components/checkbox';
import {Label} from '@proxy/ui/components/label';
import {BUTTON_EDGES} from './button-edges';
import {layoutScreens} from './layout';
import {mapSchema, type Edge, type ScreenMap} from './map-schema';
import {ScreenNode, type ScreenNodeType} from './screen-node';

const nodeTypes = {screen: ScreenNode};

type State = {kind: 'loading'} | {kind: 'missing'} | {kind: 'ready'; map: ScreenMap};

// `generated/map.json`, which Vite serves at the root. Without it the dev server answers the
// page itself, so anything that is not the map counts as missing.
async function loadMap(): Promise<State> {
	const loaded = await Result.wrapAsync(async () => {
		const response = await fetch('/map.json');
		return mapSchema.parse(await response.json());
	});
	if (loaded.isErr()) {
		return {kind: 'missing'};
	}
	return {kind: 'ready', map: loaded.value};
}

// Where screens were dragged to, by route, kept in the browser so they stay put across reloads
// and crawls. A screen never dragged keeps its place in the layout.
const POSITIONS_KEY = 'screen-map-positions';
const positionsSchema = z.record(z.string(), z.object({x: z.number(), y: z.number()}));
type Positions = z.infer<typeof positionsSchema>;

function savedPositions(): Positions {
	const parsed = positionsSchema.safeParse(
		Result.wrap(() => JSON.parse(localStorage.getItem(POSITIONS_KEY) ?? '{}')).unwrapOr({}),
	);
	return parsed.success ? parsed.data : {};
}

function savePositions(positions: Positions): void {
	localStorage.setItem(POSITIONS_KEY, JSON.stringify(positions));
}

function allEdges(map: ScreenMap): Edge[] {
	return [...map.edges, ...BUTTON_EDGES.map((edge) => ({...edge, kind: 'button' as const}))];
}

function toNodes(map: ScreenMap, moved: Positions): ScreenNodeType[] {
	const positions = layoutScreens(map.screens, allEdges(map));
	return map.screens.map((screen) => ({
		id: screen.path,
		type: 'screen',
		position: moved[screen.path] ?? positions.get(screen.path) ?? {x: 0, y: 0},
		data: {screen},
	}));
}

const STROKE: Record<Edge['kind'], React.CSSProperties> = {
	link: {},
	button: {strokeDasharray: '6 4'},
	nav: {strokeDasharray: '2 4', opacity: 0.5},
};

function toEdges(map: ScreenMap, showNav: boolean): FlowEdge[] {
	return allEdges(map)
		.filter((edge) => showNav || edge.kind !== 'nav')
		.map((edge, index) => ({
			id: `${index}`,
			source: edge.from,
			target: edge.to,
			type: 'smoothstep',
			label: edge.label ?? undefined,
			style: STROKE[edge.kind],
			markerEnd: {type: MarkerType.ArrowClosed},
		}));
}

// A move with ⇧ held stays on a rail: along whichever axis it has gone further from where it
// started, the other held where it was.
function railed(start: XYPosition, position: XYPosition, shift: boolean): XYPosition {
	if (!shift) {
		return position;
	}
	const dx = position.x - start.x;
	const dy = position.y - start.y;
	return Math.abs(dx) >= Math.abs(dy) ? {x: position.x, y: start.y} : {x: start.x, y: position.y};
}

// Whether ⌘ (Ctrl on Windows and Linux) is held: a drag then moves a screen instead of panning.
function useModifierHeld(): boolean {
	const [held, setHeld] = useState(false);
	useEffect(() => {
		const update = (event: KeyboardEvent) => setHeld(event.metaKey || event.ctrlKey);
		const release = () => setHeld(false);
		window.addEventListener('keydown', update);
		window.addEventListener('keyup', update);
		window.addEventListener('blur', release);
		return () => {
			window.removeEventListener('keydown', update);
			window.removeEventListener('keyup', update);
			window.removeEventListener('blur', release);
		};
	}, []);
	return held;
}

export function MapPage() {
	const [state, setState] = useState<State>({kind: 'loading'});
	const [showNav, setShowNav] = useState(false);
	const [moved, setMoved] = useState<Positions>(savedPositions);
	// The positions before each move, newest last, for ⌘Z.
	const [history, setHistory] = useState<Positions[]>([]);
	const [nodes, setNodes, onNodesChange] = useNodesState<ScreenNodeType>([]);
	const moving = useModifierHeld();
	// Where the screen being moved started, for the rail.
	const dragStart = useRef<XYPosition | null>(null);

	useEffect(() => {
		void loadMap().then(setState);
	}, []);

	const map = state.kind === 'ready' ? state.map : null;
	useEffect(() => {
		setNodes(map ? toNodes(map, moved) : []);
	}, [map, moved, setNodes]);
	const edges = useMemo(() => (map ? toEdges(map, showNav) : []), [map, showNav]);

	const place = (next: Positions) => {
		setHistory([...history, moved]);
		savePositions(next);
		setMoved(next);
	};

	useEffect(() => {
		const undo = (event: KeyboardEvent) => {
			const previous = history.at(-1);
			if (!(event.metaKey || event.ctrlKey) || event.key !== 'z' || event.shiftKey || !previous) {
				return;
			}
			event.preventDefault();
			setHistory(history.slice(0, -1));
			savePositions(previous);
			setMoved(previous);
		};
		window.addEventListener('keydown', undo);
		return () => window.removeEventListener('keydown', undo);
	}, [history]);

	if (state.kind === 'loading') {
		return null;
	}

	if (!map) {
		return (
			<div className="mx-auto grid max-w-md gap-2 p-8 text-sm">
				<p className="font-medium">No map yet</p>
				<p className="text-muted-foreground">
					With <code>bun run dev</code> up, run <code>bun run crawl</code> in{' '}
					<code>packages/map</code>, then reload.
				</p>
			</div>
		);
	}

	const shot = map.screens.filter((screen) => screen.screenshot !== null).length;

	return (
		<div className="h-dvh w-dvw">
			<ReactFlow
				nodes={nodes}
				edges={edges}
				nodeTypes={nodeTypes}
				onNodesChange={onNodesChange}
				onNodeDragStart={(_event, node) => {
					dragStart.current = node.position;
				}}
				onNodeDrag={(event, node) => {
					const start = dragStart.current;
					if (!event.shiftKey || !start) {
						return;
					}
					const position = railed(start, node.position, true);
					setNodes((current) =>
						current.map((other) => (other.id === node.id ? {...other, position} : other)),
					);
				}}
				onNodeDragStop={(event, node) => {
					const start = dragStart.current ?? node.position;
					place({...moved, [node.id]: railed(start, node.position, event.shiftKey)});
				}}
				fitView
				// Out to see every screen at once, in to the screenshots' own pixels (taken at twice the
				// viewport, so a card holds 8 times its width).
				minZoom={0.05}
				maxZoom={8}
				colorMode="system"
				nodesDraggable={moving}
				nodesConnectable={false}
				// Nothing is selected or boxed, so ⇧ is free for the rail.
				elementsSelectable={false}
				selectionKeyCode={null}
			>
				<Background />
				<Controls showInteractive={false} />
				<MiniMap pannable zoomable />
				<Panel
					position="top-left"
					className="grid gap-2 rounded-lg border bg-background p-3 text-sm"
				>
					<div className="font-medium">Screens</div>
					<div className="text-muted-foreground">
						{shot} of {map.screens.length} screens, crawled{' '}
						{new Date(map.generatedAt).toLocaleString()}
					</div>
					<div className="text-muted-foreground">
						Solid: a link on the page. Dashed: after a button or form. Dotted: sidebar and header.
					</div>
					<div className="text-muted-foreground">
						Drag to pan. Hold ⌘ (Ctrl on Windows and Linux) and drag a screen to move it, with ⇧ to
						keep it on a rail; ⌘Z undoes.
					</div>
					<Label className="flex items-center gap-2">
						<Checkbox
							checked={showNav}
							onCheckedChange={(checked) => setShowNav(checked === true)}
						/>
						Show sidebar and header links
					</Label>
					{Object.keys(moved).length > 0 && (
						<Button
							variant="outline"
							size="sm"
							className="justify-self-start"
							onClick={() => place({})}
						>
							Put moved screens back
						</Button>
					)}
				</Panel>
			</ReactFlow>
		</div>
	);
}
