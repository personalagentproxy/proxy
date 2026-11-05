import {AppShell, PageTitle} from '@/components/app-shell';

// What a detail page shows when its id no longer points at anything, after a delete for one.
export function NotFound({what}: {what: string}) {
	return (
		<AppShell title={<PageTitle>Not found</PageTitle>}>
			<p className="text-sm text-muted-foreground">This {what} does not exist anymore.</p>
		</AppShell>
	);
}
