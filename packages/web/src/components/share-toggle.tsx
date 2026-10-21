import {Button} from '@proxy/ui/components/button';

type Props = {
	orgName: string;
	shared: boolean;
	onChange: (shared: boolean) => void;
	// How many connections each side has, beside its label, where the toggle picks a list.
	counts?: {yours: number; shared: number};
};

// The two sides of an organization with other members, as two buttons: what is just yours,
// and what is shared with everyone in it. Picks the list on Connections, and who a new connection
// is for on Add connection.
export function ShareToggle({orgName, shared, onChange, counts}: Props) {
	return (
		<div className="flex items-center gap-2">
			<Button size="sm" variant={shared ? 'outline' : 'secondary'} onClick={() => onChange(false)}>
				Just me
				{counts && <span className="text-muted-foreground tabular-nums">{counts.yours}</span>}
			</Button>
			<Button size="sm" variant={shared ? 'secondary' : 'outline'} onClick={() => onChange(true)}>
				Everyone in {orgName}
				{counts && <span className="text-muted-foreground tabular-nums">{counts.shared}</span>}
			</Button>
		</div>
	);
}
