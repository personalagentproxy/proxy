import type {ReactNode} from 'react';
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@proxy/ui/components/select';

type Option = {value: string; label: string; icon?: ReactNode};

// Where a widget writes, which of several people a name stands for, or which agent a message goes
// to: a choice inline in a line of the widget, shown only when there is one to make. It has no
// box, as the model's name under Chat's message box has none: what is chosen, before it its icon
// where options have one, and a chevron, a ghost pill lit under the pointer. It is as large as the
// line it is in: a widget's body, or the small print beside its buttons.
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
				className="max-w-full min-w-0 gap-1.5 rounded-full border-0 px-1.5 py-0.5 text-[length:inherit] font-normal hover:bg-muted data-[size=sm]:h-auto data-[size=sm]:rounded-full dark:bg-transparent dark:hover:bg-muted [&>svg]:size-[1.15em]"
			>
				<SelectValue>
					{(chosen: string | null) => {
						const option = options.find((one) => one.value === chosen);
						return (
							<>
								{option?.icon}
								<span className="truncate text-foreground">{option?.label}</span>
							</>
						);
					}}
				</SelectValue>
			</SelectTrigger>
			<SelectContent alignItemWithTrigger={false} align="start" className="w-auto">
				{options.map((option) => (
					<SelectItem key={option.value} value={option.value}>
						{option.icon}
						{option.label}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}
