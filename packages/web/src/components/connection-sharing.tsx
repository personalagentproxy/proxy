import {useState} from 'react';
import {Link} from 'react-router';
import {ConfirmDialog} from '@/components/confirm-dialog';
import {RowList} from '@/components/row-list';
import {Section} from '@/components/section';
import {Button} from '@proxy/ui/components/button';

type Props = {
	orgName: string;
	shared: boolean;
	// Who the provider sees when an agent uses it: "Maya Chen, who signed in", a database's user.
	actsAs: string;
	// Who connected it, "You" for you.
	connectedBy: string;
	// Whether the person may share it: their own connection.
	canShare: boolean;
	// Nobody else is in the organization or invited: there is no one to share with yet.
	alone: boolean;
	onShare: () => Promise<void>;
};

const LABEL = 'w-32 shrink-0 text-muted-foreground';
const ROW = 'bleed flex h-10 items-center gap-3 text-sm';

// A connection's place in an organization with other people in it: whether everyone's agents
// can use it or only its connector's, who the provider sees, and who connected it
// (`Connection.connectedById`, kept once it is shared). One's own connection has a Share button,
// which asks first; sharing is for good, so a shared one says who can use it and nothing more.
// Alone in the organization, it points to Members instead.
export function ConnectionSharing({
	orgName,
	shared,
	actsAs,
	connectedBy,
	canShare,
	alone,
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
					to {orgName} to share connections with them.
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
				<li className={ROW}>
					<span className={LABEL}>Acts as</span>
					<span className="min-w-0 flex-1 truncate">{actsAs}</span>
				</li>
				<li className={ROW}>
					<span className={LABEL}>Connected by</span>
					<span className="min-w-0 flex-1 truncate">{connectedBy}</span>
				</li>
			</RowList>
			<ConfirmDialog
				open={confirming}
				title={`Share it with everyone in ${orgName}?`}
				description={`Every member's agents in ${orgName} can use it, as ${actsAs}, with the permissions above. Members see it listed, never its password or token. This can't be undone: to have it as your own again, disconnect it and connect it again.`}
				confirmLabel="Share"
				onClose={() => setConfirming(false)}
				onConfirm={() => void onShare()}
			/>
		</Section>
	);
}
