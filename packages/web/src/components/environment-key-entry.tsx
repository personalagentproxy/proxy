import {useState} from 'react';
import {z} from 'zod';
import {environmentService, environmentKeyLabel} from '@proxy/contracts/environments';
import {apiRequest} from '@/client/request';
import {PillButton} from '@proxy/ui/components/pill-button';

/** Quick entry beside the list; stored values are never loaded into this form. */
export function EnvironmentKeyEntry({
	base,
	projects,
	existing,
	onSaved,
}: {
	base: string;
	projects: string[];
	existing: {project: string; names: string[]}[];
	onSaved: () => Promise<void>;
}) {
	const [project, setProject] = useState(projects.length === 1 ? (projects[0] ?? '') : '');
	const [name, setName] = useState('');
	const [value, setValue] = useState('');
	const [service, setService] = useState('');
	const [busy, setBusy] = useState(false);
	const [message, setMessage] = useState('');
	const field = 'w-full min-w-0 rounded-lg border bg-background px-3 py-2 text-sm';
	async function save() {
		if (existing.some((row) => row.project === project && row.names.includes(name))) {
			setMessage('This key already exists. Open its details to edit it.');
			return;
		}
		setBusy(true);
		setMessage('');
		const result = await apiRequest(
			'PUT',
			base + '/development/' + encodeURIComponent(project) + '/keys',
			z.object({ok: z.boolean()}),
			{name, value, service: service || environmentService(name), label: environmentKeyLabel(name)},
		);
		setBusy(false);
		if (result.isErr()) {
			setMessage('Could not add key. Check the environment and variable name.');
			return;
		}
		setName('');
		setValue('');
		setService('');
		setMessage('Key saved.');
		await onSaved();
	}
	return (
		<form
			aria-label="Add a key directly"
			className="flex flex-col gap-3 rounded-lg border bg-muted/20 p-4"
			onSubmit={(e) => {
				e.preventDefault();
				void save();
			}}
		>
			<div className="text-sm font-medium">Add key</div>
			<div className="grid items-end gap-3 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_1fr_1fr_auto]">
				<label className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">
					Environment
					<input
						required
						list="key-entry-environments"
						className={field}
						placeholder="example-development"
						pattern="[a-z0-9][a-z0-9-]{0,63}"
						value={project}
						onChange={(e) => setProject(e.target.value)}
					/>
					<datalist id="key-entry-environments">
						{projects.map((p) => (
							<option key={p} value={p} />
						))}
					</datalist>
				</label>
				<label className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">
					Key
					<input
						required
						className={field + ' font-mono'}
						placeholder="OPENAI_API_KEY"
						pattern="[A-Za-z_][A-Za-z0-9_]*"
						value={name}
						onChange={(e) => {
							setName(e.target.value);
							setService(environmentService(e.target.value));
						}}
					/>
				</label>
				<label className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">
					Value
					<input
						type="password"
						autoComplete="new-password"
						className={field}
						placeholder="Enter value"
						value={value}
						onChange={(e) => setValue(e.target.value)}
					/>
				</label>
				<label className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">
					Service
					<input
						className={field}
						placeholder="Detected automatically"
						value={service}
						onChange={(e) => setService(e.target.value)}
					/>
				</label>
				<PillButton type="submit" disabled={busy}>
					Add key
				</PillButton>
			</div>
			{message && (
				<p role="status" className="text-sm">
					{message}
				</p>
			)}
		</form>
	);
}
