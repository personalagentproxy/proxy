import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@proxy/ui/components/select';

type Option = {value: string; label: string};

// Where a widget writes, or which of several people a name stands for: a choice inline in the
// widget, shown only when there is one to make. It has no box, as the model's name under Chat's
// message box has none: what is chosen and a chevron, lit under the pointer.
export function WidgetSelect({
	label,
	options,
	value,
	onChange,
}: {
	label: string;
	options: Option[];
	value: string | null;
	onChange: (value: string) => void;
}) {
	return (
		<Select
			value={value}
			items={options}
			onValueChange={(next) => {
				if (next !== null) {
					onChange(next);
				}
			}}
		>
			<SelectTrigger
				size="sm"
				aria-label={label}
				className="max-w-full min-w-0 gap-1.5 rounded-md border-0 px-1.5 py-0 hover:bg-muted data-[size=sm]:h-6 dark:bg-transparent dark:hover:bg-muted"
			>
				<SelectValue />
			</SelectTrigger>
			<SelectContent alignItemWithTrigger={false}>
				{options.map((option) => (
					<SelectItem key={option.value} value={option.value}>
						{option.label}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}
