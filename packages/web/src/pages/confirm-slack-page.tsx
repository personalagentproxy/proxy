import type {SlackConfirmation, SlackConfirmed} from '@proxy/contracts/slack';
import type {ReactNode} from 'react';
import {useState} from 'react';
import {Link, useLoaderData, useParams} from 'react-router';
import {PillButton} from '@proxy/ui/components/pill-button';
import {signOut} from '@/client/auth-client';
import {confirmSlackLink} from '@/client/slack-client';
import {OrgTile} from '@/components/org-switcher';
import {StepHeading} from '@/components/step-heading';
import {describeApiError} from '@/lib/loader-utils';
import type {confirmSlackLoader} from '@/loaders';

// Where the link a persona's app gives someone in Slack lands, to confirm who they are, signed in
// (the loader sends anyone signed out to sign in first, and back here). Confirming links their
// Slack account in the workspace to them in the organization, for every agent of it there, and the
// message they wrote is taken up without their sending it again, into a thread that lives in Slack.
export function ConfirmSlackPage() {
	const {token = ''} = useParams();
	const {me, confirmation} = useLoaderData<typeof confirmSlackLoader>();
	if (!confirmation) {
		return (
			<Frame>
				<StepHeading title="This link isn’t valid">
					It may have been cut short or changed on its way here. Write to the agent in Slack again
					for a new one.
				</StepHeading>
			</Frame>
		);
	}

	if (confirmation.state === 'expired') {
		return (
			<Frame>
				<StepHeading title="This link has run out">
					Links to confirm who you are last a day. Write to the agent in Slack again for a new one.
				</StepHeading>
			</Frame>
		);
	}

	if (confirmation.state === 'not_member') {
		return (
			<Frame>
				<StepHeading title={`You’re not in ${confirmation.orgName}`}>
					This link is for {confirmation.orgName}’s agents in the Slack workspace{' '}
					{confirmation.workspaceName}, and you’re signed in as {me.user.email}, who isn’t a member.
					Ask {confirmation.ownerName ?? 'its owner'} to invite you to {confirmation.orgName}, then
					open the link again. Nothing was linked.
				</StepHeading>
				<div>
					<PillButton variant="ghost" onClick={() => void signOut()}>
						Sign out
					</PillButton>
				</div>
			</Frame>
		);
	}

	if (confirmation.state === 'taken') {
		return (
			<Frame>
				<StepHeading title="This Slack account is someone else’s here">
					It is linked to another member of {confirmation.orgName} in {confirmation.workspaceName}.
					They can unlink it from their account; then open the link again.
				</StepHeading>
			</Frame>
		);
	}

	return <ConfirmStep token={token} email={me.user.email} confirmation={confirmation} />;
}

function Frame({children}: {children: ReactNode}) {
	return (
		<div className="flex min-h-dvh w-full justify-center bg-background p-4 pt-[12vh] text-foreground">
			<div className="grid w-full max-w-lg content-start gap-6">{children}</div>
		</div>
	);
}

// What confirming does, and the one button to do it.
function ConfirmStep({
	token,
	email,
	confirmation,
}: {
	token: string;
	email: string;
	confirmation: Extract<SlackConfirmation, {state: 'confirm'}>;
}) {
	const [confirming, setConfirming] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [confirmed, setConfirmed] = useState<SlackConfirmed | null>(null);
	if (confirmed) {
		return <Done confirmed={confirmed} />;
	}

	return (
		<Frame>
			<OrgTile org={{name: confirmation.orgName}} className="size-10 text-base" />
			<StepHeading title={`Confirm it’s you in ${confirmation.workspaceName}`}>
				{confirmation.linked
					? `Your Slack account there is linked to you already. Confirm, and ${confirmation.personaName} takes up the message you wrote.`
					: `This links your Slack account in ${confirmation.workspaceName} to you, ${email}, in ${confirmation.orgName}: what you write to ${confirmation.personaName}, or any other agent of ${confirmation.orgName} there, opens threads that live in Slack, which the agent works on as you. Unlink it from your account at any time.`}
			</StepHeading>
			{error && <p className="text-sm text-destructive">{error}</p>}
			<div className="flex gap-2">
				<PillButton
					disabled={confirming}
					onClick={async () => {
						setConfirming(true);
						const result = await confirmSlackLink(token);
						setConfirming(false);
						if (result.isErr()) {
							setError(describeApiError(result.error));
							return;
						}
						setConfirmed(result.value);
					}}
				>
					{confirming ? 'Confirming…' : 'Confirm'}
				</PillButton>
				<PillButton variant="ghost" nativeButton={false} render={<Link to="/" />}>
					Not now
				</PillButton>
			</div>
		</Frame>
	);
}

// Linked: whether the message that prompted it was taken up, and the way back to Slack.
function Done({confirmed}: {confirmed: SlackConfirmed}) {
	return (
		<Frame>
			<StepHeading title="You’re linked">
				{confirmed.takenUp
					? `${confirmed.personaName} has your message, and works on it as you. The thread it opened lives in Slack.`
					: `Write to ${confirmed.personaName} in Slack again: what you write there is taken up from now on.`}
			</StepHeading>
			<div>
				<PillButton nativeButton={false} render={<a href={confirmed.slackUrl} />}>
					Back to Slack
				</PillButton>
			</div>
		</Frame>
	);
}
