import {PageHeader, PageTitle} from '@/components/app-shell';

// What a detail page's content is when its id no longer points at anything, after a delete for
// one: in the page's frame, which it names.
export function NotFound({what}: {what: string}) {
	return (
		<>
			<PageHeader title={<PageTitle>Not found</PageTitle>} />
			<p className="text-sm text-muted-foreground">This {what} does not exist anymore.</p>
		</>
	);
}
