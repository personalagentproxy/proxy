import {Button} from '@proxy/ui/components/button';

// Something that can't be undone, in red: what it does, and its button; disabled, the description
// says what has to happen first.
export function DangerCard({
	title,
	description,
	button,
	disabled,
	onClick,
}: {
	title: string;
	description: string;
	button: string;
	disabled?: boolean;
	onClick: () => void;
}) {
	return (
		<section className="overflow-hidden rounded-xl border border-destructive/40">
			<div className="grid gap-1 p-4">
				<h2 className="text-sm font-medium">{title}</h2>
				<p className="text-sm text-muted-foreground">{description}</p>
			</div>
			<div className="flex justify-end border-t border-destructive/40 bg-destructive/5 px-4 py-3">
				<Button
					className="bg-destructive text-white hover:bg-destructive/90"
					disabled={disabled}
					onClick={onClick}
				>
					{button}
				</Button>
			</div>
		</section>
	);
}
