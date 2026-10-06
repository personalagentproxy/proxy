import {AppShell, PageTitle} from '@/components/app-shell';
import {BackButton} from '@/components/back-button';

// What a detail page shows when its id no longer points at anything, after a delete for one.
export function NotFound({what, back, backLabel}: {what: string; back: string; backLabel: string}) {
	return (
		<AppShell
			title={
				<>
					<BackButton to={back} label={backLabel} />
					<PageTitle>Not found</PageTitle>
				</>
			}
		>
			<p className="text-sm text-muted-foreground">This {what} does not exist anymore.</p>
		</AppShell>
	);
}
