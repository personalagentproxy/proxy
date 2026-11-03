import {useEffect} from 'react';
import {useSearchParams} from 'react-router';
import {Button} from '@proxy/ui/components/button';
import {StepHeading} from '@/components/step-heading';
import {sanitizeCallbackUrl} from '@/lib/callback-url';
import {desktopOpenLink} from '@/lib/desktop';

// Where the browser's work for the desktop app ends, `/desktop-return?path=`: the app opens on
// `path`, the page the work would have ended on, through its link. Browsers ask before opening
// another app, and some only on a click, so the link is on the page too.
export function DesktopReturnPage() {
	const [params] = useSearchParams();
	const link = desktopOpenLink(sanitizeCallbackUrl(params.get('path')) ?? '/');

	useEffect(() => {
		window.location.assign(link);
	}, [link]);

	return (
		<div className="flex min-h-dvh w-full justify-center bg-background p-4 pt-[12vh] text-foreground">
			<div className="grid w-full max-w-lg content-start gap-6">
				<StepHeading title="Back to Personal Agent Proxy…">
					All done here. The app goes on where you left off; you can close this tab once it has.
				</StepHeading>
				<div>
					<Button nativeButton={false} render={<a href={link} />}>
						Open Personal Agent Proxy
					</Button>
				</div>
			</div>
		</div>
	);
}
