import type {ListedPersona} from '@proxy/contracts/harness';
import {XIcon} from 'lucide-react';
import {useMatch} from 'react-router';
import {type Pane, Waiting} from '@/components/app-shell';
import {IconButton} from '@/components/icon-button';
import {PersonaSettings} from '@/components/persona-pane';

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
	// The chat's address, or the open task's, which the settings' is under and closing them goes
	// back to.
	under: string;
	// Its name and head change in their dialog (persona-dialog.tsx), and deleting it is confirmed
	// in another; who sees it is chosen in the pane itself.
	onEdit: (persona: ListedPersona) => void;
	onDelete: (persona: ListedPersona) => void;
};

/** Whether the address opens the agent's settings, and the pane as the page draws it while it does. */
export type PersonaPane = {open: boolean; pane: Pane | undefined};

/**
 * An agent's settings, in a pane at the Chat page's right, beside the task open (`AppShell`'s
 * pane), at an address of its own (`settingsPath`) under the chat's or the open task's, so the task
 * stays open beside them and Back closes them as their cross does: the agent, whose it is, and
 * Edit, which opens its name and head in their dialog; who sees it, the person alone or everyone in
 * the organization; and, at the foot, deleting it. A member who may not change it reads it alone.
 */
export function usePersonaPane({
	orgName,
	persona,
	pending,
	under,
	onEdit,
	onDelete,
}: Args): PersonaPane {
	const onChat = useMatch(`/:org/chat/:id${SETTINGS}`) !== null;
	const onTask = useMatch(`/:org/chat/:id/threads/:threadId${SETTINGS}`) !== null;
	if (!onChat && !onTask) {
		return {open: false, pane: undefined};
	}

	const content = () => {
		if (persona !== null) {
			return (
				<PersonaSettings
					key={persona.id}
					orgName={orgName}
					persona={persona}
					onEdit={() => onEdit(persona)}
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
	return {open: true, pane};
}
