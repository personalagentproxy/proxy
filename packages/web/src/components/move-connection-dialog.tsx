import type {Org} from '@proxy/contracts/orgs';
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
import {Label} from '@proxy/ui/components/label';
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@proxy/ui/components/select';

type Props = {
	// What the connection is called, for the title.
	title: string;
	// The person's other organizations, any of which it can move into; at least one.
	orgs: Org[];
	onClose: () => void;
	// Moves it into the organization picked, by its slug; what went wrong, shown in the dialog, or
	// null once moved.
	onMove: (slug: string) => Promise<string | null>;
};

// Moving a connection into another of the person's organizations: which one, Move and Cancel.
// Mount it keyed by the connection, so the pick starts from the first organization again.
export function MoveConnectionDialog({title, orgs, onClose, onMove}: Props) {
	const [slug, setSlug] = useState(orgs[0]?.slug ?? '');
	const [error, setError] = useState<string | null>(null);
	const [moving, setMoving] = useState(false);
	const items = orgs.map((org) => ({value: org.slug, label: org.name}));

	return (
		<Dialog
			open
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
						if (slug === '') {
							return;
						}
						setMoving(true);
						const failed = await onMove(slug);
						setMoving(false);
						setError(failed);
						if (failed === null) {
							onClose();
						}
					}}
				>
					<DialogHeader>
						<DialogTitle>Move {title} to another organization</DialogTitle>
						<DialogDescription>
							It becomes yours alone there. Agents here lose it at once, and who it is shared with
							here and what agents here may do with it are forgotten.
						</DialogDescription>
					</DialogHeader>
					<div className="grid gap-2">
						<Label htmlFor="move-org">Organization</Label>
						<Select
							value={slug}
							items={items}
							onValueChange={(next) => {
								if (next !== null) {
									setSlug(next);
								}
							}}
						>
							<SelectTrigger id="move-org" className="w-full">
								<SelectValue />
							</SelectTrigger>
							<SelectContent alignItemWithTrigger={false}>
								{items.map((item) => (
									<SelectItem key={item.value} value={item.value}>
										{item.label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>
					{error && <p className="text-sm text-destructive">{error}</p>}
					<DialogFooter>
						<Button type="button" variant="outline" onClick={onClose}>
							Cancel
						</Button>
						<Button type="submit" disabled={slug === '' || moving}>
							{moving ? 'Moving…' : 'Move'}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
