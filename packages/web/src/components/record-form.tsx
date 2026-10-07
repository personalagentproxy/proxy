import {useId, useState, type ReactNode} from 'react';
import type {Field} from '@proxy/integrations';
import {displayValue} from '@/lib/access';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {Label} from '@/components/ui/label';
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@/components/ui/select';
import {Textarea} from '@/components/ui/textarea';

type FormProps = {
	fields: Field[];
	initial?: Record<string, string>;
	submitLabel: string;
	onSubmit: (values: Record<string, string>) => void;
	onCancel?: () => void;
	// Extra actions at the start of the button row, such as Delete.
	extra?: ReactNode;
	// A second way to submit beside the main one, such as Save as draft beside Send.
	alternative?: {label: string; onSubmit: (values: Record<string, string>) => void};
};

const INPUT_TYPES: Partial<Record<Field['type'], string>> = {
	email: 'email',
	datetime: 'datetime-local',
	date: 'date',
};

// One form for every collection, built from its fields: the agent side's create and edit pages
// and the Information dialog alike.
export function RecordForm({
	fields,
	initial = {},
	submitLabel,
	onSubmit,
	onCancel,
	extra,
	alternative,
}: FormProps) {
	const id = useId();
	const [values, setValues] = useState(initial);
	const set = (key: string, value: string) => setValues((current) => ({...current, [key]: value}));

	return (
		<form
			className="grid gap-4"
			onSubmit={(event) => {
				event.preventDefault();
				onSubmit(values);
			}}
		>
			{fields
				.filter((field) => !field.system)
				.map((field) => (
					<div key={field.key} className="grid gap-2">
						<Label htmlFor={`${id}-${field.key}`}>{field.label}</Label>
						<FieldInput
							id={`${id}-${field.key}`}
							field={field}
							value={values[field.key] ?? ''}
							onChange={(value) => set(field.key, value)}
						/>
					</div>
				))}
			<div className="flex items-center gap-2">
				{extra}
				<span className="flex-1" />
				{onCancel && (
					<Button type="button" variant="outline" onClick={onCancel}>
						Cancel
					</Button>
				)}
				{alternative && (
					<Button type="button" variant="outline" onClick={() => alternative.onSubmit(values)}>
						{alternative.label}
					</Button>
				)}
				<Button type="submit">{submitLabel}</Button>
			</div>
		</form>
	);
}

type InputProps = {id: string; field: Field; value: string; onChange: (value: string) => void};

function FieldInput({id, field, value, onChange}: InputProps) {
	if (field.type === 'longtext') {
		return (
			<Textarea id={id} rows={5} value={value} onChange={(event) => onChange(event.target.value)} />
		);
	}

	if (field.type === 'select') {
		return (
			<Select value={value || null} onValueChange={(next) => onChange(next ?? '')}>
				<SelectTrigger id={id} className="w-full">
					<SelectValue placeholder="Choose…" />
				</SelectTrigger>
				<SelectContent>
					{(field.options ?? []).map((option) => (
						<SelectItem key={option} value={option}>
							{option}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
		);
	}

	return (
		<Input
			id={id}
			type={INPUT_TYPES[field.type] ?? 'text'}
			autoComplete="off"
			value={value}
			onChange={(event) => onChange(event.target.value)}
		/>
	);
}

// A record read back field by field, empty fields left out.
export function RecordFields({fields, values}: {fields: Field[]; values: Record<string, string>}) {
	const filled = fields.filter((field) => (values[field.key] ?? '').trim().length > 0);
	if (filled.length === 0) {
		return <p className="text-sm text-muted-foreground">Nothing filled in.</p>;
	}

	return (
		<dl className="grid gap-4">
			{filled.map((field) => (
				<div key={field.key} className="grid gap-1">
					<dt className="text-xs text-muted-foreground">{field.label}</dt>
					<dd className="text-sm whitespace-pre-wrap">
						{field.type === 'secret'
							? values[field.key]
							: displayValue(field.type, values[field.key])}
					</dd>
				</div>
			))}
		</dl>
	);
}
