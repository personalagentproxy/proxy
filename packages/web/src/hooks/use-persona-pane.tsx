import type {ListedPersona} from '@proxy/contracts/harness';
import type {SlackInstallOutcome} from '@proxy/contracts/slack';
import {XIcon} from 'lucide-react';
import {type ReactNode, useCallback, useState} from 'react';
import {useMatch} from 'react-router';
import {type Pane, Waiting} from '@/components/app-shell';
import {IconButton} from '@/components/icon-button';
import {PersonaSettings} from '@/components/persona-pane';
import {SlackDialog} from '@/components/slack-settings';
import {useOrgSlug} from '@/hooks/use-org';
import {usePersonaSlack} from '@/hooks/use-persona-slack';

// What the address of the agent's settings adds to its chat's, or to an open task's.
const SETTINGS = '/settings';

/** The address of an agent's settings, beside its chat as `path` has it, with a task open or none. */
export function settingsPath(path: string): string {
	return `${path}${SETTINGS}`;
}

type Args = {
	orgName: string;
	// The open chat's agent as the list has it: null while the list loads, and for one it doesn't
	// have.
	persona: ListedPersona | null;
	// Whether the list is still loading, so an agent it lacks may yet come.
	pending: boolean;
	// Whether the organization has the `slack` experiment on.
	slack: boolean;
	// The chat's address, or the open task's, which the settings' is under and closing them goes
	// back to.
	under: string;
	// Its name and head change in their dialog (persona-dialog.tsx), and deleting it is confirmed
	// in another; who sees it is chosen in the pane itself.
	onEdit: (persona: ListedPersona) => void;
	onDelete: (persona: ListedPersona) => void;
};

/**
 * Whether the address opens the agent's settings, the pane as the page draws it while it does, and
 * what it lays over the page: the agent's Slack dialog, where it is open.
 */
export type PersonaPane = {
	open: boolean;
	pane: Pane | undefined;
	overlay: ReactNode;
	// Opens the agent's Slack dialog on how its install in Slack ended, as the page comes back from it.
	showSlackReturn: (personaId: string, notice: SlackInstallOutcome) => void;
};

/**
 * An agent's settings, in a pane at the Chat page's right, beside the task open (`AppShell`'s
 * pane), at an address of its own (`settingsPath`) under the chat's or the open task's, so the task
 * stays open beside them and Back closes them as their cross does: the agent, whose it is, and
 * Edit, which opens its name and head in their dialog; who sees it, the person alone or everyone in
 * the organization; Slack, where the organization has it, whose card opens a dialog of its own;
 * and, at the foot, deleting it. A member who may not change it reads it alone.
 */
export function usePersonaPane({
	orgName,
	persona,
	pending,
	slack,
	under,
	onEdit,
	onDelete,
}: Args): PersonaPane {
	const org = useOrgSlug();
	const onChat = useMatch(`/:org/chat/:id${SETTINGS}`) !== null;
	const onTask = useMatch(`/:org/chat/:id/threads/:threadId${SETTINGS}`) !== null;
	const open = onChat || onTask;
	// The Slack dialog, open for an agent, with how its install last ended where the page came back.
	const [slackFor, setSlackFor] = useState<{
		personaId: string;
		notice: SlackInstallOutcome | null;
	} | null>(null);
	// Closing the pane closes its dialog.
	const [wasOpen, setWasOpen] = useState(open);
	if (wasOpen !== open) {
		setWasOpen(open);
		if (!open) {
			setSlackFor(null);
		}
	}
	// The agent in Slack, for whoever may change a shared one: its card, its dialog and the delete
	// card read it alike.
	const slackRead = usePersonaSlack(
		org,
		persona?.id ?? '',
		open && slack && persona !== null && persona.mayChange && persona.shared,
	);
	const showSlackReturn = useCallback(
		(returnedTo: string, notice: SlackInstallOutcome) =>
			setSlackFor({personaId: returnedTo, notice}),
		[],
	);

	if (!open) {
		return {open: false, pane: undefined, overlay: null, showSlackReturn};
	}

	const content = () => {
		if (persona !== null) {
			return (
				<PersonaSettings
					key={persona.id}
					orgName={orgName}
					persona={persona}
					slack={slack}
					slackRead={slackRead}
					onEdit={() => onEdit(persona)}
					onSlack={() => setSlackFor({personaId: persona.id, notice: null})}
					onDelete={() => onDelete(persona)}
				/>
			);
		}
		if (pending) {
			return (
				<div className="p-4">
					<Waiting column={false} />
				</div>
			);
		}
		return <p className="p-4 text-sm text-muted-foreground">This agent does not exist.</p>;
	};

	const pane: Pane = {
		header: (
			<>
				<span className="min-w-0 flex-1 truncate text-sm font-medium">Settings</span>
				<IconButton label="Close settings" to={under}>
					<XIcon className="size-4" />
				</IconButton>
			</>
		),
		content: content(),
	};

	const slackShown =
		persona !== null &&
		slack &&
		persona.mayChange &&
		persona.shared &&
		slackFor?.personaId === persona.id;
	const overlay = slackShown && (
		<SlackDialog
			open
			onClose={() => setSlackFor(null)}
			org={org}
			personaId={persona.id}
			name={persona.name}
			look={persona.look}
			color={persona.color}
			notice={slackFor.notice}
			slack={slackRead}
		/>
	);
	return {open: true, pane, overlay, showSlackReturn};
}
