import type {ReactNode} from 'react';
import {Button} from '@proxy/ui/components/button';
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@proxy/ui/components/dialog';
import {useCommandEnterSubmit} from '@/hooks/use-command-enter';

type Props = {
	open: boolean;
	title: string;
	description: ReactNode;
	confirmLabel: string;
	destructive?: boolean;
	onClose: () => void;
	onConfirm: () => void;
};

export function ConfirmDialog({
	open,
	title,
	description,
	confirmLabel,
	destructive = false,
	onClose,
	onConfirm,
}: Props) {
	const form = useCommandEnterSubmit(open && !destructive);

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
					ref={form}
					className="grid gap-4"
					onSubmit={(event) => {
						event.preventDefault();
						onConfirm();
						onClose();
					}}
				>
					<DialogHeader>
						<DialogTitle>{title}</DialogTitle>
						<DialogDescription>{description}</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<Button type="button" variant="outline" autoFocus={destructive} onClick={onClose}>
							Cancel
						</Button>
						<Button
							type="submit"
							variant={destructive ? 'destructive' : 'default'}
							autoFocus={!destructive}
						>
							{confirmLabel}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
