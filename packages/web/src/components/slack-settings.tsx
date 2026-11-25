import type {
	PersonaInSlack,
	SlackApp,
	SlackInstallOutcome,
	SlackWorkspace,
} from '@proxy/contracts/slack';
import type {Look} from '@proxy/utils/harness';
import {useEffect, useState} from 'react';
import {PillButton} from '@proxy/ui/components/pill-button';
import {PillTab} from '@proxy/ui/components/pill-tab';
import {pillButtonVariants} from '@proxy/ui/lib/pill-variants';
import {cn} from '@proxy/ui/lib/utils';
import {Dialog, DialogContent, DialogHeader, DialogTitle} from '@proxy/ui/components/dialog';
import {Input} from '@proxy/ui/components/input';
import {Label} from '@proxy/ui/components/label';
import {
	addToSlack,
	forgetSlackApp,
	getPersonaInSlack,
	linkSlackWorkspace,
	removeSlackApp,
	slackInstallPath,
	unlinkSlackWorkspace,
	updateSlackApp,
} from '@/client/slack-client';
import {PaneRow} from '@/components/pane-row';
import type {PersonaSlackRead} from '@/hooks/use-persona-slack';
import {downloadHeadPicture} from '@/lib/head-picture';
import {describeApiError} from '@/lib/loader-utils';

// What the page says on coming back from Slack's install.
function noticeLine(outcome: SlackInstallOutcome, name: string, workspace: string): string {
	if (outcome === 'installed') {
		return `${name} is in Slack.`;
	}
	if (outcome === 'denied') {
		return 'The install was cancelled in Slack.';
	}
	if (outcome === 'enterprise') {
		return 'Slack installed it across a whole Enterprise organization, which isn’t supported. Install it in one workspace.';
	}
	if (outcome === 'workspace') {
		return `Slack installed it in another workspace than ${workspace}. Install it again in ${workspace}.`;
	}
	return 'The install didn’t finish. Try again.';
}

// Where the app stands, in a line.
function stateLine(app: SlackApp, name: string): string {
	const handle = app.handle === null ? '' : ` as @${app.handle}`;
	if (app.state === 'waiting') {
		return `Made in ${app.workspaceName}, waiting to be installed. Where a Slack admin has to approve apps, Slack asked them; once they have, install it again.`;
	}
	if (app.state === 'out_of_date') {
		return `In ${app.workspaceName}${handle}, with an older version of its app. Update it to bring it up to date.`;
	}
	if (app.state === 'removed') {
		return `Removed from ${app.workspaceName} in Slack. Add it again, or forget it here.`;
	}
	return `${name} is in ${app.workspaceName}${handle}. Members write to it there, in its Messages tab.`;
}

const LINE = 'text-sm text-muted-foreground';

// Sends the browser through Slack's install for the app.
function install(org: string, personaId: string) {
	window.location.assign(slackInstallPath(org, personaId));
}

/**
 * Linking a workspace with an app configuration token and its refresh token, which Slack shows
 * together where they are generated: for a workspace to link, or one whose token Slack no longer
 * takes (`needsToken`).
 */
function TokenForm({
	org,
	needsToken,
	onLinked,
	onCancel,
}: {
	org: string;
	needsToken: SlackWorkspace | null;
	onLinked: () => void;
	onCancel?: () => void;
}) {
	const [token, setToken] = useState('');
	const [refreshToken, setRefreshToken] = useState('');
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const ready = token.trim() !== '' && refreshToken.trim() !== '' && !busy;
	return (
		<div className="grid gap-3" role="group" aria-label="Link a Slack workspace">
			<p className={LINE}>
				{needsToken
					? `Slack no longer takes the token ${needsToken.name} was linked with. Paste a new pair.`
					: 'Link a Slack workspace to add agents to it.'}{' '}
				At{' '}
				<a
					className="underline underline-offset-2"
					href="https://api.slack.com/apps"
					target="_blank"
					rel="noreferrer"
				>
					api.slack.com/apps
				</a>
				, signed in to the workspace, find Your App Configuration Tokens, choose Generate Token,
				pick the workspace, and copy both tokens here.
			</p>
			<div className="grid gap-2">
				<Label htmlFor="slack-token">Access token</Label>
				<Input
					id="slack-token"
					autoComplete="off"
					placeholder="xoxe.xoxp-…"
					value={token}
					onChange={(event) => setToken(event.target.value)}
				/>
			</div>
			<div className="grid gap-2">
				<Label htmlFor="slack-refresh-token">Refresh token</Label>
				<Input
					id="slack-refresh-token"
					autoComplete="off"
					placeholder="xoxe-…"
					value={refreshToken}
					onChange={(event) => setRefreshToken(event.target.value)}
				/>
			</div>
			{error && <p className="text-sm text-destructive">{error}</p>}
			<div className="flex gap-2">
				<PillButton
					type="button"
					disabled={!ready}
					onClick={async () => {
						setBusy(true);
						const linked = await linkSlackWorkspace(org, {
							token: token.trim(),
							refreshToken: refreshToken.trim(),
						});
						setBusy(false);
						if (linked.isErr()) {
							setError(describeApiError(linked.error));
							return;
						}
						onLinked();
					}}
				>
					{busy ? 'Linking…' : 'Link workspace'}
				</PillButton>
				{onCancel && (
					<PillButton type="button" variant="ghost" onClick={onCancel}>
						Cancel
					</PillButton>
				)}
			</div>
		</div>
	);
}

// Saving the head as the app's picture, which Slack only lets be set by hand.
function PictureLine({
	app,
	name,
	look,
	color,
}: {
	app: SlackApp;
	name: string;
	look: Look;
	color: string;
}) {
	const [failed, setFailed] = useState(false);
	return (
		<p className={LINE}>
			Slack only lets an app’s picture be set by hand: save{' '}
			<button
				type="button"
				className="underline underline-offset-2"
				onClick={async () => setFailed(!(await downloadHeadPicture({look, color}, name)))}
			>
				its head as a picture
			</button>
			{app.settingsUrl ? (
				<>
					{' '}
					and upload it under Display Information in{' '}
					<a
						className="underline underline-offset-2"
						href={app.settingsUrl}
						target="_blank"
						rel="noreferrer"
					>
						the app’s settings
					</a>
					.
				</>
			) : (
				'.'
			)}
			{failed && ' This browser can’t draw it.'}
		</p>
	);
}

// The persona not in Slack yet: the workspace to add it to, among those linked, and adding it.
function AddForm({
	org,
	personaId,
	name,
	workspaces,
	onChanged,
	onLinkAnother,
}: {
	org: string;
	personaId: string;
	name: string;
	workspaces: SlackWorkspace[];
	onChanged: () => void;
	onLinkAnother: () => void;
}) {
	const [chosen, setChosen] = useState(workspaces[0]?.id ?? '');
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const workspace = workspaces.find(({id}) => id === chosen) ?? workspaces[0];
	if (!workspace) {
		return null;
	}
	return (
		<div className="grid gap-3">
			<p className={LINE}>
				Add {name} to Slack as an app of its own: each member writes to it there, and it answers
				them as it does here.
			</p>
			{workspaces.length > 1 && (
				<div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Workspace">
					{workspaces.map((candidate) => (
						<PillTab
							key={candidate.id}
							type="button"
							role="radio"
							aria-checked={candidate.id === workspace.id}
							chosen={candidate.id === workspace.id}
							onClick={() => setChosen(candidate.id)}
						>
							{candidate.name}
						</PillTab>
					))}
				</div>
			)}
			{error && <p className="text-sm text-destructive">{error}</p>}
			<div className="flex flex-wrap items-center gap-2">
				<PillButton
					type="button"
					disabled={busy}
					onClick={async () => {
						setBusy(true);
						const added = await addToSlack(org, personaId, workspace.id);
						if (added.isErr()) {
							setBusy(false);
							setError(describeApiError(added.error));
							return;
						}
						install(org, personaId);
					}}
				>
					{busy ? 'Adding…' : `Add to ${workspace.name}`}
				</PillButton>
				{!workspace.inUse && (
					<PillButton
						type="button"
						variant="ghost"
						disabled={busy}
						onClick={async () => {
							const unlinked = await unlinkSlackWorkspace(org, workspace.id);
							if (unlinked.isErr()) {
								setError(describeApiError(unlinked.error));
								return;
							}
							onChanged();
						}}
					>
						Unlink {workspace.name}
					</PillButton>
				)}
				<PillButton type="button" variant="ghost" disabled={busy} onClick={onLinkAnother}>
					Link another workspace
				</PillButton>
			</div>
		</div>
	);
}

// The persona's app as it stands, with what can be done to it from here.
function AppPanel({
	org,
	personaId,
	name,
	look,
	color,
	app,
	onChanged,
}: {
	org: string;
	personaId: string;
	name: string;
	look: Look;
	color: string;
	app: SlackApp;
	onChanged: () => void;
}) {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	// Slack couldn't delete it: forgetting it here alone is offered.
	const [stuck, setStuck] = useState(false);

	const remove = async () => {
		setBusy(true);
		const removed = await removeSlackApp(org, personaId);
		setBusy(false);
		if (removed.isErr()) {
			setError(describeApiError(removed.error));
			setStuck(true);
			return;
		}
		onChanged();
	};
	const forget = async () => {
		setBusy(true);
		const forgotten = await forgetSlackApp(org, personaId);
		setBusy(false);
		if (forgotten.isErr()) {
			setError(describeApiError(forgotten.error));
			return;
		}
		onChanged();
	};
	const update = async () => {
		setBusy(true);
		const updated = await updateSlackApp(org, personaId);
		if (updated.isErr()) {
			setBusy(false);
			setError(describeApiError(updated.error));
			return;
		}
		if (updated.value.install) {
			install(org, personaId);
			return;
		}
		setBusy(false);
		onChanged();
	};

	return (
		<div className="grid gap-3">
			<p className={LINE}>{stateLine(app, name)}</p>
			{(app.state === 'in_slack' || app.state === 'out_of_date') && (
				<PictureLine app={app} name={name} look={look} color={color} />
			)}
			{error && <p className="text-sm text-destructive">{error}</p>}
			{stuck && (
				<p className={LINE}>
					Forgetting it here leaves the app in {app.workspaceName}, for a Slack admin there to
					delete.
				</p>
			)}
			<div className="flex flex-wrap gap-2">
				{app.state === 'waiting' && (
					<PillButton type="button" disabled={busy} onClick={() => install(org, personaId)}>
						Install
					</PillButton>
				)}
				{app.state === 'out_of_date' && (
					<PillButton type="button" disabled={busy} onClick={update}>
						{busy ? 'Updating…' : 'Update'}
					</PillButton>
				)}
				{app.state === 'removed' && (
					<PillButton type="button" disabled={busy} onClick={() => install(org, personaId)}>
						Add again
					</PillButton>
				)}
				{stuck || app.state === 'removed' ? (
					<PillButton type="button" variant="ghost" disabled={busy} onClick={forget}>
						Forget it here
					</PillButton>
				) : (
					<PillButton type="button" variant="ghost" disabled={busy} onClick={remove}>
						{busy ? 'Removing…' : 'Remove from Slack'}
					</PillButton>
				)}
			</div>
		</div>
	);
}

// What the row says the app is, and the word of its action.
function appRow(app: SlackApp): {line: string; action: string} {
	const handle =
		app.handle === null ? `In ${app.workspaceName}` : `@${app.handle} in ${app.workspaceName}`;
	if (app.state === 'waiting') {
		return {line: `Waiting to be installed in ${app.workspaceName}`, action: 'Install'};
	}
	if (app.state === 'out_of_date') {
		return {line: `${handle}, out of date`, action: 'Update'};
	}
	if (app.state === 'removed') {
		return {line: `Removed from ${app.workspaceName} in Slack`, action: 'Add again'};
	}
	return {line: handle, action: 'Manage'};
}

/**
 * The persona's Slack row in its settings, for whoever may change it: where it stands, and the one
 * action that opens the dialog holding the rest (`SlackDialog`); for one of their own, that it has
 * to be shared first.
 */
export function SlackRow({
	shared,
	orgName,
	slack,
	onOpen,
}: {
	shared: boolean;
	orgName: string;
	slack: PersonaSlackRead;
	onOpen: () => void;
}) {
	if (!shared) {
		return (
			<PaneRow title="Slack" line={`Share it with everyone in ${orgName} to add it to Slack`} />
		);
	}
	if (slack.failed !== null) {
		return (
			<PaneRow title="Slack" line={<span className="text-destructive">{slack.failed}</span>} />
		);
	}
	if (slack.loaded === null) {
		return <PaneRow title="Slack" line="Loading…" />;
	}
	const {app} = slack.loaded;
	if (app === null) {
		return (
			<PaneRow
				title="Slack"
				line="Members message it there, as themselves"
				action={
					<PillButton type="button" onClick={onOpen}>
						Add to Slack
					</PillButton>
				}
			/>
		);
	}
	const {line, action} = appRow(app);
	return (
		<PaneRow
			title="Slack"
			line={line}
			action={
				<PillButton type="button" variant="ghost" className="bg-muted" onClick={onOpen}>
					{action}
				</PillButton>
			}
		/>
	);
}

/**
 * The persona's Slack row for a member who may not change it: where to write to it in Slack, once
 * it is there; nothing otherwise.
 */
export function SlackPresenceRow({org, personaId}: {org: string; personaId: string}) {
	const [inSlack, setInSlack] = useState<PersonaInSlack['inSlack']>(null);
	useEffect(() => {
		let current = true;
		void getPersonaInSlack(org, personaId).then((answer) => {
			if (!current || answer.isErr()) {
				return;
			}
			setInSlack(answer.value.inSlack);
		});
		return () => {
			current = false;
		};
	}, [org, personaId]);
	if (inSlack === null) {
		return null;
	}
	return (
		<PaneRow
			title="Slack"
			line={`@${inSlack.handle} in ${inSlack.workspaceName}`}
			action={
				<a
					className={cn(pillButtonVariants({variant: 'ghost'}), 'bg-muted')}
					href={inSlack.slackUrl}
					target="_blank"
					rel="noreferrer"
				>
					Open in Slack
				</a>
			}
		/>
	);
}

/**
 * The persona in Slack, in a dialog of its own over its settings, for an organization with the
 * `slack` experiment on and a shared persona: its own Slack app as it stands, adding it to a linked
 * workspace, and linking one where none is; and how its install in Slack last ended, where the page
 * just came back from it.
 */
export function SlackDialog({
	open,
	onClose,
	org,
	personaId,
	name,
	look,
	color,
	notice,
	slack,
}: {
	open: boolean;
	onClose: () => void;
	org: string;
	personaId: string;
	name: string;
	look: Look;
	color: string;
	notice: SlackInstallOutcome | null;
	slack: PersonaSlackRead;
}) {
	// Linking a workspace beside those linked, as asked.
	const [linking, setLinking] = useState(false);

	const changed = () => {
		setLinking(false);
		slack.reload();
	};

	const body = () => {
		if (slack.failed !== null) {
			return <p className="text-sm text-destructive">{slack.failed}</p>;
		}
		if (slack.loaded === null) {
			return <p className={LINE}>Loading…</p>;
		}
		const {app, workspaces, unavailable} = slack.loaded;
		const needsToken = workspaces.find((workspace) => workspace.needsToken) ?? null;
		if (app !== null) {
			// Nothing is changed in Slack until the app's workspace has a token that works again.
			const stale = workspaces.find(
				(workspace) => workspace.id === app.workspaceId && workspace.needsToken,
			);
			return (
				<>
					{stale && <TokenForm org={org} needsToken={stale} onLinked={changed} />}
					<AppPanel
						org={org}
						personaId={personaId}
						name={name}
						look={look}
						color={color}
						app={app}
						onChanged={changed}
					/>
				</>
			);
		}
		if (unavailable !== null) {
			return <p className={LINE}>{unavailable}</p>;
		}
		const usable = workspaces.filter((workspace) => !workspace.needsToken);
		if (!linking && needsToken === null && usable.length === 0) {
			return (
				<div className="grid gap-3">
					<p className={LINE}>
						Add {name} to Slack as an app of its own, which members write to there. Link a Slack
						workspace first.
					</p>
					<div>
						<PillButton type="button" variant="ghost" onClick={() => setLinking(true)}>
							Link a Slack workspace
						</PillButton>
					</div>
				</div>
			);
		}
		if (linking || needsToken !== null || usable.length === 0) {
			return (
				<TokenForm
					org={org}
					needsToken={needsToken}
					onLinked={changed}
					onCancel={linking ? () => setLinking(false) : undefined}
				/>
			);
		}
		return (
			<AddForm
				org={org}
				personaId={personaId}
				name={name}
				workspaces={usable}
				onChanged={changed}
				onLinkAnother={() => setLinking(true)}
			/>
		);
	};

	const workspaceName = slack.loaded?.app?.workspaceName ?? 'its workspace';
	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				if (next) {
					return;
				}
				setLinking(false);
				onClose();
			}}
		>
			{/* Scrolls within the window where the token form makes it taller than that. */}
			<DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
				<div className="grid gap-4">
					<DialogHeader>
						<DialogTitle>{name} in Slack</DialogTitle>
					</DialogHeader>
					{notice !== null && <p className="text-sm">{noticeLine(notice, name, workspaceName)}</p>}
					{body()}
				</div>
			</DialogContent>
		</Dialog>
	);
}
