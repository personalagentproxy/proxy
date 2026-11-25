import type {ListedPersona} from '@proxy/contracts/harness';
import {useState} from 'react';
import {PillButton} from '@proxy/ui/components/pill-button';
import {PillTab} from '@proxy/ui/components/pill-tab';
import {cn} from '@proxy/ui/lib/utils';
import {updatePersona} from '@/client/harness-client';
import {DangerCard} from '@/components/danger-card';
import {LiveHead} from '@/components/head';
import {PANE_CARD} from '@/components/pane-row';
import {SlackPresenceRow, SlackRow} from '@/components/slack-settings';
import {useOrgSlug} from '@/hooks/use-org';
import type {PersonaSlackRead} from '@/hooks/use-persona-slack';
import {useReload} from '@/hooks/use-reload';
import {describeApiError} from '@/lib/loader-utils';

const LINE = 'text-sm text-muted-foreground';

// Whose the agent is, in a line under its name: a shared one by who made it, or, where its maker
// has left the organization, just whom it is for.
function whoseLine(persona: ListedPersona, orgName: string): string {
	if (!persona.shared) {
		return 'Yours alone';
	}
	if (persona.madeBy === 'you') {
		return `Made by you, for everyone in ${orgName}`;
	}
	if (persona.madeBy !== null) {
		return `Made by ${persona.madeBy.name}`;
	}
	return `For everyone in ${orgName}`;
}

// What the choice of who sees it means, in a line.
function sharingLine(shared: boolean, orgName: string): string {
	if (shared) {
		return 'Each person’s conversation with it is their own.';
	}
	return `Nobody else in ${orgName} sees it.`;
}

// What deleting the agent takes with it: every member's conversation where others have talked to
// it, the person's own otherwise; and its Slack app where it is in Slack.
function deleteCardLine(persona: ListedPersona, inSlack: boolean): string {
	const conversations = persona.usedByOthers
		? `Every member’s conversation with ${persona.name} goes with it, not only yours: others have talked to it.`
		: `Your conversation with ${persona.name} goes with it.`;
	const slack = inSlack ? ' It is removed from Slack first.' : '';
	return `${conversations}${slack} This cannot be undone.`;
}

// The pane's content, scrolling within itself: the agent, whose it is, and Edit, which opens its
// name and head in their dialog; a card for who sees it, which holds as it is chosen; where the
// organization has Slack (`slack`), a card for the agent in Slack, whose action opens a dialog of
// its own; and, at the pane's foot however short the rest, the card that deletes it. Without
// `mayChange`, it is read alone: who sees it said, Slack where it is there, and neither Edit, the
// choice nor the card.
export function PersonaSettings({
	orgName,
	persona,
	slack,
	slackRead,
	onEdit,
	onSlack,
	onDelete,
}: {
	orgName: string;
	persona: ListedPersona;
	slack: boolean;
	slackRead: PersonaSlackRead;
	onEdit: () => void;
	onSlack: () => void;
	onDelete: () => void;
}) {
	const org = useOrgSlug();
	const reload = useReload();
	// Who sees it as just chosen, while the server is told; and what it refused it with.
	const [choosing, setChoosing] = useState<boolean | null>(null);
	const [refused, setRefused] = useState<string | null>(null);
	const shared = choosing ?? persona.shared;
	// A shared one that can't go back to the person alone: why, said up front.
	const keptShared = persona.shared && persona.staysShared !== null;

	const choose = async (next: boolean) => {
		if (next === shared || choosing !== null) {
			return;
		}
		setChoosing(next);
		setRefused(null);
		const changed = await updatePersona(org, persona.id, {
			name: persona.name,
			look: persona.look,
			color: persona.color,
			shared: next,
		});
		if (changed.isErr()) {
			setChoosing(null);
			setRefused(describeApiError(changed.error));
			return;
		}
		await reload();
		setChoosing(null);
	};

	return (
		<section aria-label="Agent settings" className="flex min-h-0 flex-1 flex-col overflow-y-auto">
			<div className="flex w-full flex-1 flex-col gap-3 p-4">
				<div className="flex items-center gap-3.5 px-4 pb-2">
					<LiveHead look={persona.look} color={persona.color} size={72} />
					<div className="grid min-w-0 flex-1 gap-0.5">
						<span className="truncate text-[17px] leading-snug font-medium">{persona.name}</span>
						<span className={LINE}>{whoseLine(persona, orgName)}</span>
					</div>
					{persona.mayChange && (
						<PillButton type="button" variant="ghost" className="bg-muted" onClick={onEdit}>
							Edit
						</PillButton>
					)}
				</div>
				<section aria-label="Who sees it" className={cn('grid gap-2.5', PANE_CARD)}>
					<div className="grid gap-0.5">
						<h3 className="text-sm font-medium">Who sees it</h3>
						<p className={LINE}>
							{persona.mayChange
								? sharingLine(shared, orgName)
								: `Everyone in ${orgName}. Each person’s conversation with it is their own.`}
						</p>
					</div>
					{persona.mayChange && (
						<div
							className="flex flex-wrap items-center gap-2"
							role="group"
							aria-label="Who sees it"
						>
							<PillTab
								type="button"
								chosen={!shared}
								aria-pressed={!shared}
								disabled={keptShared}
								onClick={() => void choose(false)}
							>
								Only you
							</PillTab>
							<PillTab
								type="button"
								chosen={shared}
								aria-pressed={shared}
								onClick={() => void choose(true)}
							>
								Everyone in {orgName}
							</PillTab>
						</div>
					)}
					{persona.mayChange && keptShared && <p className={LINE}>{persona.staysShared}</p>}
					{refused !== null && <p className="text-sm text-destructive">{refused}</p>}
				</section>
				{slack && persona.mayChange && (
					<SlackRow shared={persona.shared} orgName={orgName} slack={slackRead} onOpen={onSlack} />
				)}
				{slack && !persona.mayChange && <SlackPresenceRow org={org} personaId={persona.id} />}
				{persona.mayChange && (
					<div className="mt-auto pt-6">
						<DangerCard
							title={`Delete ${persona.name}`}
							description={deleteCardLine(persona, (slackRead.loaded?.app ?? null) !== null)}
							button="Delete agent"
							onClick={onDelete}
						/>
					</div>
				)}
			</div>
		</section>
	);
}
