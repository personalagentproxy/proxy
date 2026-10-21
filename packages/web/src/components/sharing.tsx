import {useState} from 'react';
import {Link} from 'react-router';
import {ConfirmDialog} from '@/components/confirm-dialog';
import {RowList} from '@/components/row-list';
import {Section} from '@/components/section';
import {Button} from '@proxy/ui/components/button';

type Props = {
	orgName: string;
	shared: boolean;
	// What is shared: 'connection' or 'agent', in the texts.
	what: string;
	// What else to say of it: who it acts as, who connected or made it.
	rows: Array<{label: string; value: string}>;
	// Whether the person may share it: their own.
	canShare: boolean;
	// Nobody else is in the organization or invited: there is no one to share with yet.
	alone: boolean;
	// What sharing means, under the question.
	confirmDescription: string;
	onShare: () => Promise<void>;
};

const LABEL = 'w-32 shrink-0 text-muted-foreground';
const ROW = 'bleed flex h-10 items-center gap-3 text-sm';

// A connection's or an agent's place in an organization with other people in it: whether everyone
// can use it or only its owner, and what else there is to say of it. One's own has a Share button,
// which asks first; sharing is for good, so a shared one says who can use it and nothing more.
// Alone in the organization, it points to Members instead.
export function Sharing({
	orgName,
	shared,
	what,
	rows,
	canShare,
	alone,
	confirmDescription,
	onShare,
}: Props) {
	const [confirming, setConfirming] = useState(false);

	if (alone) {
		return (
			<Section title="Sharing">
				<p className="text-sm text-muted-foreground">
					<Link to="/members" className="text-foreground underline underline-offset-4">
						Invite people
					</Link>{' '}
					to {orgName} to share {what}s with them.
				</p>
			</Section>
		);
	}

	return (
		<Section title="Sharing">
			<RowList>
				<li className={ROW}>
					<span className={LABEL}>Who can use it</span>
					<span className="min-w-0 flex-1 truncate">
						{shared ? `Everyone in ${orgName}` : 'Just you'}
					</span>
					{!shared && canShare && (
						<Button variant="outline" size="sm" onClick={() => setConfirming(true)}>
							Share with everyone
						</Button>
					)}
				</li>
				{rows.map((row) => (
					<li key={row.label} className={ROW}>
						<span className={LABEL}>{row.label}</span>
						<span className="min-w-0 flex-1 truncate">{row.value}</span>
					</li>
				))}
			</RowList>
			<ConfirmDialog
				open={confirming}
				title={`Share it with everyone in ${orgName}?`}
				description={confirmDescription}
				confirmLabel="Share"
				onClose={() => setConfirming(false)}
				onConfirm={() => void onShare()}
			/>
		</Section>
	);
}
