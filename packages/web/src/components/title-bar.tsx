import {PanelLeftIcon} from 'lucide-react';
import {HistoryButtons} from '@/components/history';
import {IconButton} from '@/components/icon-button';
import {useSidebar} from '@proxy/ui/components/sidebar';

// The start of the title bar on the human side (index.css), in a browser as in the desktop app,
// after the desktop app's traffic lights: the button that folds the navigation away and back out,
// and back and forward at the right of the navigation's top row, which fold away with it. With the
// navigation folded away, or a sheet on a phone, the toggle alone, and the page's header goes on
// after it (useTitleBarHeader).
export function TitleBarStart() {
	const {state, isMobile, toggleSidebar} = useSidebar();
	const out = state === 'expanded' && !isMobile;
	const label = isMobile ? 'Open sidebar' : out ? 'Hide sidebar' : 'Show sidebar';
	return (
		<div data-title-bar className="flex items-center gap-0.5">
			<IconButton label={label} onClick={toggleSidebar}>
				<PanelLeftIcon className="size-4" />
			</IconButton>
			{!isMobile && (
				// Folded away with the navigation, out of reach of the pointer and the keyboard.
				<div data-title-bar-history inert={!out} className="flex items-center gap-0.5">
					<HistoryButtons />
				</div>
			)}
		</div>
	);
}
