import {
	Handle,
	NodeToolbar,
	Position,
	useStore,
	type Node,
	type NodeProps,
	type ReactFlowState,
} from '@xyflow/react';
import {NODE_WIDTH} from './layout';
import type {Screen} from './map-schema';

const zoomOf = (state: ReactFlowState) => state.transform[2];

export type ScreenNodeType = Node<{screen: Screen}, 'screen'>;

// One screen: its screenshot, with its route above it as a frame's title, the same size at any
// zoom (the toolbar is drawn outside the zoomed viewport) and cut to the card's width on screen,
// so zoomed out the routes do not run into each other. The route opens the screen in the app, the
// screenshot opens full size. Nothing is draggable, so a drag starting on the card pans.
export function ScreenNode({data: {screen}}: NodeProps<ScreenNodeType>) {
	const zoom = useStore(zoomOf);

	return (
		<>
			<NodeToolbar
				isVisible
				position={Position.Top}
				align="start"
				offset={6}
				className="truncate font-mono text-xs text-muted-foreground"
				style={{maxWidth: NODE_WIDTH * zoom}}
			>
				{screen.url ? (
					<a href={screen.url} target="_blank" rel="noreferrer" className="hover:text-foreground">
						{screen.path}
					</a>
				) : (
					screen.path
				)}
			</NodeToolbar>
			<div className="w-80 overflow-hidden rounded-md border bg-card shadow-sm">
				<Handle type="target" position={Position.Top} className="invisible!" />
				{screen.screenshot ? (
					<a href={`/${screen.screenshot}`} target="_blank" rel="noreferrer" draggable={false}>
						<img
							src={`/${screen.screenshot}`}
							alt={screen.path}
							draggable={false}
							className="block w-full"
						/>
					</a>
				) : (
					<div className="flex h-50 items-center justify-center text-xs text-muted-foreground">
						No screenshot
					</div>
				)}
				<Handle type="source" position={Position.Bottom} className="invisible!" />
			</div>
		</>
	);
}
