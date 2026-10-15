import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@proxy/ui/components/select';

type Option = {value: string; label: string};

// Where a widget writes, or which of several people a name stands for: a choice inline in the
// widget, shown only when there is one to make.
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
			<SelectTrigger size="sm" aria-label={label} className="max-w-full min-w-0">
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
