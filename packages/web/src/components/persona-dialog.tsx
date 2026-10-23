import {useState} from 'react';
import type {Persona} from '@/client/harness-client';
import {AGENT_NAME_MAX} from '@proxy/integrations';
import {Avatar, AvatarPicker} from '@/components/avatar';
import {Button} from '@proxy/ui/components/button';
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@proxy/ui/components/dialog';
import {Input} from '@proxy/ui/components/input';
import {Label} from '@proxy/ui/components/label';

type Props = {
	open: boolean;
	// The persona as it is, to change; none to make one.
	initial: Persona | null;
	onClose: () => void;
	// Saves the persona; what went wrong, shown in the dialog, or null once saved.
	onSave: (persona: Persona) => Promise<string | null>;
	// Deletes the persona with its conversation, where it is one that exists.
	onDelete?: () => Promise<string | null>;
};

const DEFAULT: Persona = {name: '', shape: 'circle', color: 'blue'};

// Making a persona, or changing one: its name, and its face from the shapes and colors, shown
// as it will be beside the name. Mount it keyed by what is edited, so the fields start from it.
export function PersonaDialog({open, initial, onClose, onSave, onDelete}: Props) {
	const [persona, setPersona] = useState<Persona>(initial ?? DEFAULT);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const ready = persona.name.trim() !== '';

	const finish = (failed: string | null) => {
		setBusy(false);
		setError(failed);
		if (failed === null) {
			onClose();
		}
	};

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				if (next) {
					return;
				}
				onClose();
			}}
		>
			<DialogContent>
				<form
					className="grid gap-5"
					onSubmit={async (event) => {
						event.preventDefault();
						if (!ready || busy) {
							return;
						}
						setBusy(true);
						finish(await onSave({...persona, name: persona.name.trim()}));
					}}
				>
					<DialogHeader>
						<DialogTitle>{initial ? 'Edit agent' : 'New agent'}</DialogTitle>
						<DialogDescription>
							{initial
								? 'Its name and its face. The conversation stays as it is.'
								: 'An agent for one kind of thing, such as Finance or Outreach, with a conversation that keeps going.'}
						</DialogDescription>
					</DialogHeader>
					<div className="flex items-center gap-4">
						<Avatar shape={persona.shape} color={persona.color} size="lg" />
						<div className="grid flex-1 gap-2">
							<Label htmlFor="persona-name">Name</Label>
							<Input
								id="persona-name"
								autoFocus
								autoComplete="off"
								maxLength={AGENT_NAME_MAX}
								placeholder="Finance"
								value={persona.name}
								onChange={(event) => setPersona({...persona, name: event.target.value})}
							/>
						</div>
					</div>
					<AvatarPicker
						shape={persona.shape}
						color={persona.color}
						onChange={(face) => setPersona({...persona, ...face})}
					/>
					{error && <p className="text-sm text-destructive">{error}</p>}
					<DialogFooter>
						{onDelete && (
							<Button
								type="button"
								variant="destructive"
								className="mr-auto"
								disabled={busy}
								onClick={async () => {
									setBusy(true);
									finish(await onDelete());
								}}
							>
								Delete
							</Button>
						)}
						<Button type="button" variant="outline" onClick={onClose}>
							Cancel
						</Button>
						<Button type="submit" disabled={!ready || busy}>
							{busy ? 'Saving…' : initial ? 'Save' : 'Create'}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
