import type {ReactNode} from 'react';
import {useState} from 'react';
import {Link, useLoaderData, useNavigate, useParams} from 'react-router';
import {signOut} from '@/client/auth-client';
import {acceptInvitation, type InvitationLink} from '@/client/orgs-client';
import {OrgTile} from '@/components/org-switcher';
import {StepHeading} from '@/components/step-heading';
import {Button} from '@proxy/ui/components/button';
import {describeApiError} from '@/lib/loader-utils';
import type {inviteLoader} from '@/loaders';

// Where an invitation's link lands, signed in (the loader sends anyone signed out to sign in or up
// first, and back here). Joining makes the person a member and opens the organization; the welcome
// flow is the first organization's, not every one's.
export function InvitePage() {
	const {token = ''} = useParams();
	const {me, invitation} = useLoaderData<typeof inviteLoader>();
	if (!invitation) {
		return (
			<Frame>
				<StepHeading title="This invitation link isn’t valid">
					It may have been taken up already or taken back. Check the link in the email, or ask
					whoever invited you to send it again.
				</StepHeading>
			</Frame>
		);
	}

	if (invitation.member) {
		return <AlreadyIn invitation={invitation} />;
	}

	if (invitation.expired) {
		return (
			<Frame>
				<StepHeading title="This invitation has expired">
					Invitations last a week. Ask {invitation.invitedBy ?? 'whoever invited you'} to invite you
					to {invitation.orgName} again.
				</StepHeading>
			</Frame>
		);
	}

	if (invitation.email.toLowerCase() !== me.user.email.toLowerCase()) {
		return (
			<Frame>
				<StepHeading title={`This invitation is for ${invitation.email}`}>
					You’re signed in as {me.user.email}. Sign in as {invitation.email} to join{' '}
					{invitation.orgName}; nothing changes for this account.
				</StepHeading>
				<div>
					<Button onClick={() => void signOut()}>Sign out</Button>
				</div>
			</Frame>
		);
	}

	return <JoinStep token={token} invitation={invitation} />;
}

function Frame({children}: {children: ReactNode}) {
	return (
		<div className="flex min-h-dvh w-full justify-center bg-background p-4 pt-[12vh] text-foreground">
			<div className="grid w-full max-w-lg content-start gap-6">{children}</div>
		</div>
	);
}

// Already a member: the way in, opening the organization.
function AlreadyIn({invitation}: {invitation: InvitationLink}) {
	const navigate = useNavigate();
	return (
		<Frame>
			<StepHeading title={`You’re in ${invitation.orgName}`}>
				You’re already a member, so there is nothing to join.
			</StepHeading>
			<div>
				<Button onClick={() => void navigate(`/${invitation.orgSlug}`)}>
					Open {invitation.orgName}
				</Button>
			</div>
		</Frame>
	);
}

// What joining gives: the organization's shared connections and agents, open in the switcher.
function JoinStep({token, invitation}: {token: string; invitation: InvitationLink}) {
	const navigate = useNavigate();
	const [joining, setJoining] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const org = {name: invitation.orgName};

	return (
		<Frame>
			<OrgTile org={org} className="size-10 rounded-lg text-base" />
			<StepHeading title={`Join ${invitation.orgName}`}>
				{invitation.invitedBy ?? 'Someone'} invited you. You work with the connections and agents
				shared with everyone in {invitation.orgName}, and what you connect there stays yours unless
				you share it. Switch back to your own organization from the top of the sidebar.
			</StepHeading>
			{error && <p className="text-sm text-destructive">{error}</p>}
			<div className="flex gap-2">
				<Button
					disabled={joining}
					onClick={async () => {
						setJoining(true);
						const result = await acceptInvitation(token);
						setJoining(false);
						if (result.isErr()) {
							setError(describeApiError(result.error));
							return;
						}
						await navigate(`/${result.value.orgSlug}`);
					}}
				>
					{joining ? 'Joining…' : `Join ${invitation.orgName}`}
				</Button>
				<Button variant="outline" nativeButton={false} render={<Link to="/" />}>
					Not now
				</Button>
			</div>
		</Frame>
	);
}
