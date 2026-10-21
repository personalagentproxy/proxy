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
	description: string;
	// What is typed again to confirm, in any case: the account's address, the organization's name.
	word: string;
	// The button, such as Delete account.
	confirmLabel: string;
	onClose: () => void;
	// Does it; what went wrong, shown in the dialog, or null once it is done.
	onConfirm: () => Promise<string | null>;
};

// Something that can't be undone, such as deleting the account or an organization, asks for its
// name typed again before it is done.
export function TypeToConfirmDialog({
	open,
	title,
	description,
	word,
	confirmLabel,
	onClose,
	onConfirm,
}: Props) {
	const [typed, setTyped] = useState('');
	const [error, setError] = useState<string | null>(null);
	const [deleting, setDeleting] = useState(false);
	const ready = typed.trim().toLowerCase() === word.trim().toLowerCase();

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				if (next || deleting) {
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
						setDeleting(true);
						const failed = await onConfirm();
						setDeleting(false);
						setError(failed);
					}}
				>
					<DialogHeader>
						<DialogTitle>{title}</DialogTitle>
						<DialogDescription>{description}</DialogDescription>
					</DialogHeader>
					<div className="grid gap-2">
						<Label htmlFor="type-to-confirm">Type {word} to confirm</Label>
						<Input
							id="type-to-confirm"
							autoFocus
							autoComplete="off"
							value={typed}
							onChange={(event) => setTyped(event.target.value)}
						/>
					</div>
					{error && <p className="text-sm text-destructive">{error}</p>}
					<DialogFooter>
						<Button type="button" variant="outline" disabled={deleting} onClick={onClose}>
							Cancel
						</Button>
						<Button type="submit" variant="destructive" disabled={!ready || deleting}>
							{deleting ? 'Deleting…' : confirmLabel}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
