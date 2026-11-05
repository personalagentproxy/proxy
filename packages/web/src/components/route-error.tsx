import {useEffect} from 'react';
import {isRouteErrorResponse, useRouteError} from 'react-router';
import {Button} from '@proxy/ui/components/button';
import {log, serializeError} from '@/lib/log';

// What a page shows when its data could not be loaded, such as when the api is down.
export function RouteError() {
	const error = useRouteError();
	const notFound = isRouteErrorResponse(error) && error.status === 404;

	// A page that failed to load or render is worth the log; a missing one is not.
	useEffect(() => {
		if (notFound) {
			return;
		}
		const detail = isRouteErrorResponse(error)
			? {status: error.status, data: error.data}
			: serializeError(error);
		log.error('page failed', {...detail, page: window.location.pathname});
	}, [error, notFound]);

	return (
		<div className="flex min-h-dvh w-full flex-col items-center justify-center gap-4 bg-background text-foreground">
			<p className="text-sm text-muted-foreground">
				{notFound ? 'This page does not exist.' : 'Something went wrong loading this page.'}
			</p>
			<Button variant="outline" onClick={() => window.location.reload()}>
				Try again
			</Button>
		</div>
	);
}
