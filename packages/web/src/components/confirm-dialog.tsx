import type {ReactNode} from 'react';
import {PillButton} from '@proxy/ui/components/pill-button';
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
	// What the button that closes it without doing anything says.
	cancelLabel?: string;
	// A second way through, between closing and confirming, where there is one.
	secondary?: {label: string; onClick: () => void};
	onClose: () => void;
	onConfirm: () => void;
};

export function ConfirmDialog({
	open,
	title,
	description,
	confirmLabel,
	destructive = false,
	cancelLabel = 'Cancel',
	secondary,
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
			{/* Wider with a second way through, so the three buttons sit on one line. */}
			<DialogContent className={secondary ? 'sm:max-w-lg' : undefined}>
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
						<PillButton type="button" variant="ghost" autoFocus={destructive} onClick={onClose}>
							{cancelLabel}
						</PillButton>
						{secondary && (
							<PillButton
								type="button"
								variant="outline"
								onClick={() => {
									secondary.onClick();
									onClose();
								}}
							>
								{secondary.label}
							</PillButton>
						)}
						{destructive ? (
							<PillButton type="submit" variant="destructive">
								{confirmLabel}
							</PillButton>
						) : (
							<PillButton type="submit" autoFocus>
								{confirmLabel}
							</PillButton>
						)}
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
