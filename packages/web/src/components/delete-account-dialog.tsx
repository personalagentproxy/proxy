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
	// The account's address, typed again to confirm.
	email: string;
	onClose: () => void;
	// Deletes the account; what went wrong, shown in the dialog, or null once it is gone.
	onDelete: () => Promise<string | null>;
};

// Deleting the account can't be undone, so it asks for the account's address before it does.
export function DeleteAccountDialog({open, email, onClose, onDelete}: Props) {
	const [typed, setTyped] = useState('');
	const [error, setError] = useState<string | null>(null);
	const [deleting, setDeleting] = useState(false);
	const ready = typed.trim().toLowerCase() === email.toLowerCase();

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
						const failed = await onDelete();
						setDeleting(false);
						setError(failed);
					}}
				>
					<DialogHeader>
						<DialogTitle>Delete your account?</DialogTitle>
						<DialogDescription>
							Every connection is first invalidated at the provider (where possible), and then
							deleted from Personal Agent Proxy, along with your information, agents and activity.
							This cannot be undone.
						</DialogDescription>
					</DialogHeader>
					<div className="grid gap-2">
						<Label htmlFor="delete-account-email">Type {email} to confirm</Label>
						<Input
							id="delete-account-email"
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
							{deleting ? 'Deleting…' : 'Delete account'}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
