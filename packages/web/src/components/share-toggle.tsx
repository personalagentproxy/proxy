import type {ReactNode} from 'react';
import {EmptyRows} from '@/components/row-list';
import {PillTab} from '@proxy/ui/components/pill-tab';
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
// agent. The side picked is filled in (`PillTab`, `aria-pressed`); the other is its label alone.
export function ShareToggle({orgName, shared, onChange, counts, sharedLabel}: Props) {
	return (
		<div className="flex items-center gap-2">
			<PillTab chosen={!shared} aria-pressed={!shared} onClick={() => onChange(false)}>
				Just me
				{counts && <span className="text-muted-foreground tabular-nums">{counts.yours}</span>}
			</PillTab>
			<PillTab chosen={shared} aria-pressed={shared} onClick={() => onChange(true)}>
				{sharedLabel ?? `Everyone in ${orgName}`}
				{counts && <span className="text-muted-foreground tabular-nums">{counts.shared}</span>}
			</PillTab>
		</div>
	);
}

/**
 * The bar over a list with two sides (`useSide`): the toggle, with how many each has, where the
 * person isn't alone in the organization, and the list's add action at its right.
 */
export function SideToggle({
	side,
	orgName,
	sharedLabel,
	add,
}: {
	side: SideChoice;
	orgName: string;
	sharedLabel?: string;
	add: ReactNode;
}) {
	return (
		<div className="flex items-center gap-4">
			{side.others && (
				<ShareToggle
					orgName={orgName}
					shared={side.shared}
					counts={side.counts}
					onChange={side.pick}
					sharedLabel={sharedLabel}
				/>
			)}
			<div className="ml-auto">{add}</div>
		</div>
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
