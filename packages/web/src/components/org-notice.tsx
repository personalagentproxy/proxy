import {useSearchParams} from 'react-router';

// What Connections says once the person is out of an organization, by leaving it (`?left=Acme`)
// or deleting it (`?deleted=Acme`), another one already open.
export function OrgNotice() {
	const [params] = useSearchParams();
	const left = params.get('left');
	const deleted = params.get('deleted');
	const name = left ?? deleted;
	if (!name) {
		return null;
	}

	return (
		<p className="rounded-lg bg-muted px-3 py-2 text-sm">
			{left ? `You left ${name}.` : `You deleted ${name}.`}{' '}
			<span className="text-muted-foreground">
				{left
					? 'Its connections and agents are no longer yours to use.'
					: 'Every connection in it was disconnected, and its agents are gone.'}
			</span>
		</p>
	);
}
