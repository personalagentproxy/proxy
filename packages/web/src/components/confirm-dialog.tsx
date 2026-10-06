import type {ReactNode} from 'react';
import {Button} from '@/components/ui/button';
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@/components/ui/dialog';

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
				<DialogHeader>
					<DialogTitle>{title}</DialogTitle>
					<DialogDescription>{description}</DialogDescription>
				</DialogHeader>
				<DialogFooter>
					<Button variant="outline" onClick={onClose}>
						Cancel
					</Button>
					<Button
						variant={destructive ? 'destructive' : 'default'}
						onClick={() => {
							onConfirm();
							onClose();
						}}
					>
						{confirmLabel}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
