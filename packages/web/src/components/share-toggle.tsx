import type {ReactNode} from 'react';
import {EmptyRows} from '@/components/row-list';
import {Button} from '@proxy/ui/components/button';
import type {SideChoice} from '@/hooks/use-side';

type Props = {
	orgName: string;
	shared: boolean;
	onChange: (shared: boolean) => void;
	// How many each side has, beside its label, where the toggle picks a list.
	counts?: {yours: number; shared: number};
	// What the shared side is called where it isn't every member's alone: a list of connections,
	// which are also shared with members by name.
	sharedLabel?: string;
};

// The two sides of an organization with other members, as two buttons: what is just yours,
// and what is shared, with everyone in it unless `sharedLabel` says otherwise. Picks the list on
// Connections and Agents, and who a new connection or agent is for on Add connection and New
// agent. The side picked is filled in; the other is its label alone, with no border or fill.
export function ShareToggle({orgName, shared, onChange, counts, sharedLabel}: Props) {
	return (
		<div className="flex items-center gap-2">
			<Button size="sm" variant={shared ? 'ghost' : 'secondary'} onClick={() => onChange(false)}>
				Just me
				{counts && <span className="text-muted-foreground tabular-nums">{counts.yours}</span>}
			</Button>
			<Button size="sm" variant={shared ? 'secondary' : 'ghost'} onClick={() => onChange(true)}>
				{sharedLabel ?? `Everyone in ${orgName}`}
				{counts && <span className="text-muted-foreground tabular-nums">{counts.shared}</span>}
			</Button>
		</div>
	);
}

/** The toggle over a list with two sides (`useSide`), with how many each has; nothing alone. */
export function SideToggle({
	side,
	orgName,
	sharedLabel,
}: {
	side: SideChoice;
	orgName: string;
	sharedLabel?: string;
}) {
	if (!side.others) {
		return null;
	}
	return (
		<ShareToggle
			orgName={orgName}
			shared={side.shared}
			counts={side.counts}
			onChange={side.pick}
			sharedLabel={sharedLabel}
		/>
	);
}

/** What an empty list with two sides says: alone in the organization, or on either side. */
export function SideEmpty({
	side,
	alone,
	shared,
	own,
}: {
	side: SideChoice;
	alone: ReactNode;
	shared: ReactNode;
	own: ReactNode;
}) {
	if (!side.others) {
		return <EmptyRows>{alone}</EmptyRows>;
	}
	return <EmptyRows>{side.shared ? shared : own}</EmptyRows>;
}
