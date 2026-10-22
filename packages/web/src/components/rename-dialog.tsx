import {useState} from 'react';
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
	title: string;
	// What the name is for, under the title: whether it can be left empty.
	description: string;
	initial: string;
	// Whether an empty name is taken, as it is where a service's own name stands in.
	allowEmpty: boolean;
	// The longest name it can have.
	maxLength?: number;
	onClose: () => void;
	// Saves the name; what went wrong, shown in the dialog, or null once saved.
	onSave: (name: string) => Promise<string | null>;
};

// Renaming something in a small dialog: the name, Save and Cancel. Mount it keyed by what is
// renamed, so the field starts from that thing's name.
export function RenameDialog({
	open,
	title,
	description,
	initial,
	allowEmpty,
	maxLength = 80,
	onClose,
	onSave,
}: Props) {
	const [name, setName] = useState(initial);
	const [error, setError] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	const ready = allowEmpty || name.trim() !== '';

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
					className="grid gap-4"
					onSubmit={async (event) => {
						event.preventDefault();
						if (!ready) {
							return;
						}
						setSaving(true);
						const failed = await onSave(name.trim());
						setSaving(false);
						setError(failed);
						if (failed === null) {
							onClose();
						}
					}}
				>
					<DialogHeader>
						<DialogTitle>{title}</DialogTitle>
						<DialogDescription>{description}</DialogDescription>
					</DialogHeader>
					<div className="grid gap-2">
						<Label htmlFor="rename-name">Name</Label>
						<Input
							id="rename-name"
							autoFocus
							autoComplete="off"
							maxLength={maxLength}
							value={name}
							onChange={(event) => setName(event.target.value)}
						/>
					</div>
					{error && <p className="text-sm text-destructive">{error}</p>}
					<DialogFooter>
						<Button type="button" variant="outline" onClick={onClose}>
							Cancel
						</Button>
						<Button type="submit" disabled={!ready || saving}>
							{saving ? 'Saving…' : 'Save'}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
