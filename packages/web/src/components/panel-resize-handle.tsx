import {type KeyboardEvent, type PointerEvent, useRef} from 'react';
import {PANEL_MAX_WIDTH, PANEL_MIN_WIDTH, type PanelWidth} from '@/hooks/use-panel-width';

// How far an arrow key moves the edge, and with Shift held.
const STEP = 16;
const BIG_STEP = 64;

/**
 * The second sidebar's right edge, which the person drags to make it wider or narrower. A line
 * shows on it under the pointer, and stays while it is dragged or focused. From the keyboard it is
 * a separator: the arrows move it, Home and End take it to its narrowest and widest, and Enter
 * puts it back, as a double click does.
 */
export function PanelResizeHandle({label, panel}: {label: string; panel: PanelWidth}) {
	// Where the drag began: the pointer's x and the width then. Null while nothing is dragged.
	const drag = useRef<{x: number; width: number} | null>(null);

	const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
		if (event.button !== 0) {
			return;
		}
		event.preventDefault();
		event.currentTarget.setPointerCapture(event.pointerId);
		drag.current = {x: event.clientX, width: panel.width};
		document.body.dataset.panelResizing = '';
	};

	const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
		if (!drag.current) {
			return;
		}
		panel.preview(drag.current.width + event.clientX - drag.current.x);
	};

	const onPointerEnd = (event: PointerEvent<HTMLDivElement>) => {
		if (!drag.current) {
			return;
		}
		panel.commit(drag.current.width + event.clientX - drag.current.x);
		drag.current = null;
		delete document.body.dataset.panelResizing;
	};

	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		const step = event.shiftKey ? BIG_STEP : STEP;
		const keys: Record<string, () => void> = {
			ArrowLeft: () => panel.commit(panel.width - step),
			ArrowRight: () => panel.commit(panel.width + step),
			Home: () => panel.commit(PANEL_MIN_WIDTH),
			End: () => panel.commit(PANEL_MAX_WIDTH),
			Enter: panel.reset,
		};
		const act = keys[event.key];
		if (!act) {
			return;
		}
		event.preventDefault();
		act();
	};

	return (
		<div
			role="separator"
			aria-orientation="vertical"
			aria-label={label}
			aria-valuenow={panel.width}
			aria-valuemin={PANEL_MIN_WIDTH}
			aria-valuemax={PANEL_MAX_WIDTH}
			tabIndex={0}
			data-panel-resize-handle
			title="Drag to resize, double-click to reset"
			onPointerDown={onPointerDown}
			onPointerMove={onPointerMove}
			onPointerUp={onPointerEnd}
			onPointerCancel={onPointerEnd}
			onDoubleClick={panel.reset}
			onKeyDown={onKeyDown}
			className="group absolute inset-y-0 -right-1.5 z-30 flex w-3 cursor-col-resize touch-none justify-center outline-none"
		>
			<span
				aria-hidden
				className="h-full w-0.5 bg-transparent transition-colors duration-150 group-hover:bg-sidebar-ring/60 group-focus-visible:bg-sidebar-ring group-active:bg-sidebar-ring"
			/>
		</div>
	);
}
