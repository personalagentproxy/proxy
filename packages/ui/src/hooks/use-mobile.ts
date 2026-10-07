import {useDesktop} from '@proxy/ui/hooks/use-media-query';

// The shadcn sidebar's breakpoint hook, pointed at the app's one desktop switch so both agree.
export function useIsMobile(): boolean {
	return !useDesktop();
}
