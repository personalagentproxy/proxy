import {useEffect} from 'react';
import {useLoaderData} from 'react-router';
import {PillButton} from '@/components/pill-button';
import {StepHeading} from '@/components/step-heading';
import type {desktopAuthLoader} from '@/loaders';

// Where the desktop app sends the browser to sign it in, with its challenge. The loader has sent
// anyone signed out to sign in first, and back here, and minted the code; all that is left is to
// hand it to the app through its link. Browsers ask before opening another app, and some only on a
// click, so the link is on the page too.
export function DesktopAuthPage() {
	const {link} = useLoaderData<typeof desktopAuthLoader>();

	useEffect(() => {
		window.location.assign(link);
	}, [link]);

	return (
		<div className="flex min-h-dvh w-full justify-center bg-background p-4 pt-[12vh] text-foreground">
			<div className="grid w-full max-w-lg content-start gap-6">
				<StepHeading title="Opening Personal Agent Proxy…">
					You’re signed in. The app opens with this account; you can close this tab once it has.
				</StepHeading>
				<div>
					<PillButton nativeButton={false} render={<a href={link} />}>
						Open Personal Agent Proxy
					</PillButton>
				</div>
			</div>
		</div>
	);
}
