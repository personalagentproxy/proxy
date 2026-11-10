import {Component, type ReactNode, useEffect} from 'react';
import {isRouteErrorResponse, useRouteError} from 'react-router';
import {Button} from '@proxy/ui/components/button';
import {LoadFailure} from '@/lib/loader-utils';
import {log, serializeError} from '@/lib/log';
import {cn} from '@proxy/ui/lib/utils';

function isNotFound(error: unknown): boolean {
	if (error instanceof LoadFailure) {
		return error.notFound;
	}
	return isRouteErrorResponse(error) && error.status === 404;
}

// What is said of a page that could not be loaded or drawn, with a way to try again.
function Failure({error, className}: {error: unknown; className: string}) {
	const notFound = isNotFound(error);

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
		<div className={cn('flex w-full flex-col items-center justify-center gap-4', className)}>
			<p className="text-sm text-muted-foreground">
				{notFound ? 'This page does not exist.' : 'Something went wrong loading this page.'}
			</p>
			<Button variant="outline" onClick={() => window.location.reload()}>
				Try again
			</Button>
		</div>
	);
}

// What a page shows when its data could not be loaded before it opened, such as when the api is
// down: in place of the whole page.
export function RouteError() {
	const error = useRouteError();
	return <Failure error={error} className="min-h-dvh bg-background text-foreground" />;
}

type BoundaryState = {failed: false} | {failed: true; error: unknown};

/**
 * Around a page's content, in its frame (app-shell.tsx): what the content failed with, loading
 * after the page opened (`useLoaded`) or drawing, is said in its place, the frame staying up.
 */
export class ContentBoundary extends Component<{children: ReactNode}, BoundaryState> {
	state: BoundaryState = {failed: false};

	static getDerivedStateFromError(error: unknown): BoundaryState {
		return {failed: true, error};
	}

	render() {
		if (!this.state.failed) {
			return this.props.children;
		}
		return <Failure error={this.state.error} className="py-[16vh]" />;
	}
}
