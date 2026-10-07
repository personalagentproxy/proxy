import {isRouteErrorResponse, useRouteError} from 'react-router';
import {Button} from '@proxy/ui/components/button';

// What a page shows when its data could not be loaded, such as when the api is down.
export function RouteError() {
	const error = useRouteError();
	const notFound = isRouteErrorResponse(error) && error.status === 404;

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
