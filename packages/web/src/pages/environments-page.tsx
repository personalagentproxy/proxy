import {useCallback, useEffect, useRef, useState} from 'react';
import {z} from 'zod';
import {EyeIcon, EyeOffIcon, KeyRoundIcon, PlusIcon, SearchIcon, ArrowLeftIcon} from 'lucide-react';
import {
	environmentOverviewSchema,
	environmentHistorySchema,
	environmentService,
	environmentKeyLabel,
	type EnvironmentRow,
} from '@proxy/contracts/environments';
import type {AgentLogin} from '@proxy/contracts/agents';
import {AppShell, PageTitle} from '@/components/app-shell';
import {PersonAvatar} from '@/components/person-avatar';
import {IntegrationLogo} from '@/components/brand-logo';
import {INTEGRATIONS} from '@/lib/integrations';
import {useOrgSlug} from '@/hooks/use-org';
import {listAgents} from '@/client/agents-client';
import {apiRequest, orgApi} from '@/client/request';
import {PillButton as Button} from '@proxy/ui/components/pill-button';
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
	DialogDescription,
} from '@proxy/ui/components/dialog';

const input =
	'w-full rounded-lg border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring';
const okSchema = z.object({ok: z.boolean()});
type Overview = z.infer<typeof environmentOverviewSchema>;
type History = z.infer<typeof environmentHistorySchema>['access'];
function ServiceMark({service}: {service: string}) {
	if (service === 'OpenAI') {
		return (
			<img src="/agent-providers/chatgpt.png" alt="" className="size-5 rounded object-contain" />
		);
	}
	if (service === 'Anthropic') {
		return (
			<img src="/llm-providers/anthropic.ico" alt="" className="size-5 rounded object-contain" />
		);
	}
	const vendor = INTEGRATIONS.find((item) => item.name.toLowerCase() === service.toLowerCase());
	if (vendor) {
		return <IntegrationLogo integration={vendor} />;
	}
	return <KeyRoundIcon aria-hidden className="size-5 text-muted-foreground" />;
}
function dateLabel(value: string | null) {
	if (!value) {
		return 'Never';
	}
	return new Date(value).toLocaleString(undefined, {
		month: 'short',
		day: 'numeric',
		hour: '2-digit',
		minute: '2-digit',
	});
}
export function EnvironmentsPage() {
	const org = useOrgSlug();
	return <EnvironmentList key={org} org={org} />;
}
function EnvironmentList({org}: {org: string}) {
	const base = orgApi(org) + '/environments';
	const [data, setData] = useState<Overview | null>(null);
	const [agents, setAgents] = useState<AgentLogin[]>([]);
	const [error, setError] = useState('');
	const [notice, setNotice] = useState('');
	const [search, setSearch] = useState('');
	const [selected, setSelected] = useState<{project: string; service: string} | null>(null);
	const [tab, setTab] = useState<'keys' | 'sharing' | 'history'>('keys');
	const [editor, setEditor] = useState<{
		project: string;
		name: string;
		label: string;
		service: string;
		existing: boolean;
	} | null>(null);
	const [secret, setSecret] = useState('');
	const [busy, setBusy] = useState(false);
	const [revealed, setRevealed] = useState<Record<string, string>>({});
	const revealGeneration = useRef(0);
	const hideSecrets = useCallback(() => {
		revealGeneration.current += 1;
		setRevealed({});
	}, []);
	useEffect(
		() => () => {
			revealGeneration.current += 1;
		},
		[],
	);
	const [history, setHistory] = useState<History>([]);
	const [recipient, setRecipient] = useState('');
	const [allowed, setAllowed] = useState<string[]>([]);
	const refresh = useCallback(async () => {
		const result = await apiRequest('GET', base + '/overview', environmentOverviewSchema);
		if (result.isErr()) {
			setError('Could not load environments. Please try again.');
			return;
		}
		setData(result.value);
		if (result.value.canManage) {
			const available = await listAgents(org);
			if (available.isOk()) {
				setAgents(available.value.agents.filter((a) => !a.revokedAt));
			}
		}
	}, [base, org]);
	useEffect(() => {
		void refresh();
	}, [refresh]);
	useEffect(() => {
		const hide = () => hideSecrets();
		const timer = window.setTimeout(hide, 60000);
		window.addEventListener('blur', hide);
		return () => {
			window.clearTimeout(timer);
			window.removeEventListener('blur', hide);
		};
	}, [revealed, hideSecrets]);
	const row = data?.rows.find(
		(item) => item.project === selected?.project && item.service === selected?.service,
	);
	const endpoint = (project: string, action: string) =>
		base + '/development/' + encodeURIComponent(project) + '/' + action;
	function open(item: EnvironmentRow, view: 'keys' | 'sharing' | 'history' = 'keys') {
		setSelected({project: item.project, service: item.service});
		setTab(view);
		hideSecrets();
		setHistory([]);
		setRecipient('');
		setAllowed([]);
		setError('');
	}
	async function reveal(name: string) {
		if (!row) {
			return;
		}
		if (Object.hasOwn(revealed, name)) {
			setRevealed((current) =>
				Object.fromEntries(Object.entries(current).filter(([key]) => key !== name)),
			);
			return;
		}
		setBusy(true);
		const generation = revealGeneration.current;
		const result = await apiRequest(
			'POST',
			endpoint(row.project, 'reveal'),
			z.object({variables: z.record(z.string(), z.string())}),
			{names: [name]},
		);
		setBusy(false);
		if (result.isErr()) {
			setError('Access denied or unavailable. Your permissions may have changed.');
			return;
		}
		if (generation !== revealGeneration.current) {
			return;
		}
		setRevealed((current) => ({...current, ...result.value.variables}));
		void refresh();
	}
	async function loadHistory() {
		if (!row) {
			return;
		}
		setTab('history');
		hideSecrets();
		setHistory([]);
		const result = await apiRequest(
			'POST',
			endpoint(row.project, 'history'),
			environmentHistorySchema,
			{names: row.keys.map((k) => k.name)},
		);
		if (result.isErr()) {
			setError('Could not load access history.');
			return;
		}
		setHistory(result.value.access);
	}
	function chooseRecipient(value: string) {
		setRecipient(value);
		setNotice('');
		const [kind, id] = value.split(':');
		setAllowed(row?.grants.find((g) => g.kind === kind && g.id === id)?.names ?? []);
	}
	async function share() {
		if (!row || !recipient) {
			return;
		}
		const [kind, id] = recipient.split(':');
		setBusy(true);
		const result = await apiRequest('PUT', endpoint(row.project, 'sharing'), okSchema, {
			kind,
			id,
			scope: row.keys.map((k) => k.name),
			names: allowed,
		});
		setBusy(false);
		if (result.isErr()) {
			setError('Could not update sharing. No permissions were changed.');
			return;
		}
		setError('');
		setNotice('Access saved.');
		await refresh();
	}
	async function removeKey() {
		if (!editor || !window.confirm('Delete ' + editor.name + ' and revoke all access to it?')) {
			return;
		}
		setBusy(true);
		const result = await apiRequest(
			'DELETE',
			endpoint(editor.project, 'keys/' + encodeURIComponent(editor.name)),
			okSchema,
		);
		setBusy(false);
		if (result.isErr()) {
			setError('Could not delete key.');
			return;
		}
		setEditor(null);
		setSecret('');
		hideSecrets();
		setSelected(null);
		await refresh();
	}
	async function save() {
		if (!editor) {
			return;
		}
		setBusy(true);
		const result = await apiRequest('PUT', endpoint(editor.project, 'keys'), okSchema, {
			name: editor.name,
			label: editor.label,
			service: editor.service,
			...(!editor.existing || secret !== '' ? {value: secret} : {}),
		});
		setBusy(false);
		if (result.isErr()) {
			setError('Could not save. Check the environment name and key.');
			return;
		}
		setSelected({project: editor.project, service: editor.service});
		setSecret('');
		setEditor(null);
		hideSecrets();
		setError('');
		await refresh();
	}
	const filtered =
		data?.rows.filter((item) =>
			[item.service, item.project, ...item.keys.map((k) => k.name)]
				.join(' ')
				.toLowerCase()
				.includes(search.toLowerCase()),
		) ?? [];
	return (
		<AppShell
			scroll="inside"
			title={
				<PageTitle detail={data ? `${data.rows.length} shown` : undefined}>Environments</PageTitle>
			}
			actions={
				data?.canManage && (
					<Button
						onClick={() => {
							setSecret('');
							setError('');
							setEditor({
								project: row?.project ?? '',
								name: '',
								label: '',
								service: row?.service ?? 'Other configuration',
								existing: false,
							});
						}}
					>
						<PlusIcon className="size-4" />
						Add key
					</Button>
				)
			}
		>
			<div className="w-full min-w-0 space-y-6 overflow-auto p-6">
				{error && (
					<p
						role="alert"
						className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm"
					>
						{error}
					</p>
				)}
				{!selected && (
					<>
						<div className="relative max-w-sm">
							<SearchIcon
								aria-hidden
								className="absolute left-3 top-2.5 size-4 text-muted-foreground"
							/>
							<input
								aria-label="Search environments"
								placeholder="Search services, environments or keys"
								className={input + ' pl-9'}
								value={search}
								onChange={(e) => setSearch(e.target.value)}
							/>
						</div>
						<div className="overflow-x-auto">
							<table className="w-full min-w-[760px] text-left text-sm">
								<thead className="text-xs font-normal text-muted-foreground">
									<tr>
										{[
											'Service',
											'Environment',
											'Keys',
											'People with access',
											'Last access',
											'Accesses · 30 days',
											'',
										].map((title, i) => (
											<th key={i} className="px-3 pb-4 font-normal">
												{title}
											</th>
										))}
									</tr>
								</thead>
								<tbody>
									{filtered.map((item) => (
										<tr
											key={item.project + ':' + item.service}
											className="group border-b border-border/40 hover:bg-muted/40"
										>
											<td className="px-3 py-4">
												<button
													className="flex items-center gap-3 text-left font-medium hover:underline"
													onClick={() => open(item)}
												>
													<ServiceMark service={item.service} />
													{item.service}
												</button>
											</td>
											<td className="px-3 py-4">
												<span className="rounded-md bg-muted px-2 py-1 text-xs">
													{item.project}
												</span>
												<span className="mt-1 block text-xs text-muted-foreground">
													Development
												</span>
											</td>
											<td className="px-3 py-4 tabular-nums">{item.keys.length}</td>
											<td className="px-3 py-4">
												<div className="flex -space-x-1">
													{data?.people
														.filter((p) => item.people.includes(p.userId))
														.map((person) => (
															<span
																key={person.userId}
																title={
																	(person.name ?? person.email) + (person.owner ? ' · Owner' : '')
																}
																className="rounded-full ring-2 ring-background"
															>
																<PersonAvatar person={person} />
																<span className="sr-only">{person.name ?? person.email}</span>
															</span>
														))}
												</div>
											</td>
											<td className="px-3 py-4 text-muted-foreground">
												<time dateTime={item.lastAccess ?? undefined}>
													{dateLabel(item.lastAccess)}
												</time>
											</td>
											<td className="px-3 py-4 tabular-nums">{item.accesses30Days}</td>
											<td className="px-3 py-4">
												{data?.canManage && (
													<button
														className="font-medium hover:underline"
														onClick={() => open(item, 'sharing')}
													>
														Share
														<span className="sr-only">
															{' '}
															{item.service} {item.project}
														</span>
													</button>
												)}
											</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
						{!data && !error && (
							<p className="py-12 text-center text-muted-foreground">Loading environments…</p>
						)}
						{data && filtered.length === 0 && (
							<div className="py-12 text-center">
								<KeyRoundIcon className="mx-auto mb-3 size-7 text-muted-foreground" />
								<p>{search ? 'No matching environments.' : 'No keys shared with you yet.'}</p>
								{data.canManage && !search && (
									<p className="mt-2 text-sm text-muted-foreground">
										Add a key to get started. Its service is detected from the variable name.
									</p>
								)}
							</div>
						)}
						<p className="text-xs text-muted-foreground">
							Access counts measure successful key retrievals through Proxy, including agent runtime
							requests. External use of copied keys cannot be tracked.
						</p>
					</>
				)}
				{row && (
					<>
						<button
							className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
							onClick={() => {
								setSelected(null);
								hideSecrets();
								setError('');
							}}
						>
							<ArrowLeftIcon className="size-4" />
							All environments
						</button>
						<div className="flex items-center gap-3">
							<ServiceMark service={row.service} />
							<div>
								<h1 className="text-xl font-semibold">{row.service}</h1>
								<p className="text-sm text-muted-foreground">
									{row.project} · Development · {row.keys.length} keys
								</p>
							</div>
						</div>
						<div className="flex gap-5 border-b text-sm">
							{(['keys', 'sharing', 'history'] as const)
								.filter((t) => t !== 'sharing' || data?.canManage)
								.map((t) => (
									<button
										key={t}
										className={
											'pb-3 capitalize ' +
											(tab === t
												? 'border-b-2 border-foreground font-medium'
												: 'text-muted-foreground')
										}
										onClick={() => {
											hideSecrets();
											setTab(t);
											if (t === 'history') {
												void loadHistory();
											}
										}}
									>
										{t === 'history' ? 'Access history' : t === 'sharing' ? 'Share' : t}
									</button>
								))}
						</div>
						{tab === 'keys' && (
							<div className="space-y-2">
								{row.keys.map((key) => (
									<div
										key={key.name}
										className="grid gap-3 rounded-lg border p-4 sm:grid-cols-[1fr_1fr_auto] sm:items-center"
									>
										<div>
											<p className="text-sm font-medium">{key.label}</p>
											<code className="break-all text-xs text-muted-foreground">{key.name}</code>
										</div>
										<code className="break-all rounded bg-muted/60 px-3 py-2 text-sm">
											{Object.hasOwn(revealed, key.name) ? revealed[key.name] : '••••••••••••'}
										</code>
										<div className="flex gap-3">
											<button
												disabled={busy}
												aria-label={
													(Object.hasOwn(revealed, key.name) ? 'Hide ' : 'Reveal ') + key.name
												}
												onClick={() => void reveal(key.name)}
											>
												{Object.hasOwn(revealed, key.name) ? (
													<EyeOffIcon className="size-4" />
												) : (
													<EyeIcon className="size-4" />
												)}
											</button>
											{data?.canManage && (
												<button
													className="text-sm hover:underline"
													onClick={() => {
														setSecret('');
														hideSecrets();
														setEditor({
															project: row.project,
															name: key.name,
															label: key.label,
															service: row.service,
															existing: true,
														});
													}}
												>
													Edit
												</button>
											)}
										</div>
									</div>
								))}
								<p className="pt-3 text-xs text-muted-foreground">
									Revealing a value is logged. Values hide after one minute or when this window
									loses focus.
								</p>
							</div>
						)}
						<Dialog
							open={tab === 'sharing'}
							onOpenChange={(open) => {
								if (!open) {
									setTab('keys');
								}
							}}
						>
							<DialogContent className="max-h-[85vh] overflow-y-auto">
								<DialogHeader>
									<DialogTitle>Share {row.service}</DialogTitle>
									<DialogDescription>{row.project}</DialogDescription>
								</DialogHeader>
								<div className="space-y-5">
									{error && (
										<p role="alert" className="text-sm text-destructive">
											{error}
										</p>
									)}
									{notice && (
										<p role="status" className="text-sm">
											{notice}
										</p>
									)}
									<p className="text-sm text-muted-foreground">
										Share selected keys with a person or agent. Owners can manage and reveal all
										keys. People can reveal shared keys; agents can retrieve them at runtime.
									</p>
									<label className="block space-y-2 text-sm">
										<span>Person or agent</span>
										<select
											className={input}
											value={recipient}
											onChange={(e) => chooseRecipient(e.target.value)}
										>
											<option value="">Select a recipient</option>
											<optgroup label="People">
												{data?.people
													.filter((p) => !p.owner)
													.map((p) => (
														<option key={p.userId} value={'person:' + p.userId}>
															{p.name ?? p.email}
														</option>
													))}
											</optgroup>
											<optgroup label="Agents">
												{agents.map((a) => (
													<option key={a.id} value={'agent:' + a.id}>
														{a.name}
													</option>
												))}
											</optgroup>
										</select>
									</label>
									{recipient && (
										<>
											<div className="space-y-3 rounded-lg border p-4">
												{row.keys.map((k) => (
													<label key={k.name} className="flex items-start gap-3 text-sm">
														<input
															type="checkbox"
															className="mt-1"
															checked={allowed.includes(k.name)}
															onChange={(e) =>
																setAllowed((previous) =>
																	e.target.checked
																		? [...previous, k.name]
																		: previous.filter((n) => n !== k.name),
																)
															}
														/>
														<span>
															{k.label}
															<code className="block break-all text-xs text-muted-foreground">
																{k.name}
															</code>
														</span>
													</label>
												))}
											</div>
											<Button disabled={busy} onClick={() => void share()}>
												Save access
											</Button>
											<p className="text-xs text-muted-foreground">
												Uncheck all keys to revoke this recipient’s access. Already copied values
												require rotation at the vendor.
											</p>
										</>
									)}
								</div>
							</DialogContent>
						</Dialog>
						{tab === 'history' && (
							<div className="space-y-3">
								<p className="text-xs text-muted-foreground">
									Most recent 100 events for these keys. The overview’s 30-day count includes the
									full window.
								</p>
								{history.length === 0 && (
									<p className="py-8 text-sm text-muted-foreground">No access events to show.</p>
								)}
								{history.map((event) => (
									<div
										key={event.id}
										className="flex flex-wrap justify-between gap-2 border-b py-3 text-sm"
									>
										<div>
											<p>
												{event.actor}{' '}
												<span className="text-muted-foreground">
													· {event.method} · {event.allowed ? 'Allowed' : 'Denied'}
												</span>
											</p>
											<p className="mt-1 break-all text-xs text-muted-foreground">
												{event.names.join(', ')}
											</p>
										</div>
										<time className="text-xs text-muted-foreground">
											{dateLabel(event.createdAt)}
										</time>
									</div>
								))}
							</div>
						)}
					</>
				)}
			</div>
			<Dialog
				open={editor !== null}
				onOpenChange={(open) => {
					if (!open) {
						setEditor(null);
						setSecret('');
					}
				}}
			>
				<DialogContent className="max-h-[85vh] overflow-y-auto">
					<DialogHeader>
						<DialogTitle>{editor?.existing ? 'Edit key' : 'Add key'}</DialogTitle>
						<DialogDescription>
							Values are encrypted and shared only with approved recipients.
						</DialogDescription>
					</DialogHeader>
					{error && (
						<p role="alert" className="text-sm text-destructive">
							{error}
						</p>
					)}
					{editor && (
						<form
							className="space-y-4"
							onSubmit={(e) => {
								e.preventDefault();
								void save();
							}}
						>
							<label className="block space-y-1 text-sm">
								Environment
								<input
									required
									disabled={editor.existing}
									className={input}
									placeholder="my-project-development"
									pattern="[a-z0-9][a-z0-9-]{0,63}"
									value={editor.project}
									onChange={(e) => setEditor({...editor, project: e.target.value})}
								/>
							</label>
							<label className="block space-y-1 text-sm">
								Variable name
								<input
									required
									disabled={editor.existing}
									className={input + ' font-mono'}
									placeholder="OPENAI_API_KEY"
									value={editor.name}
									onChange={(e) =>
										setEditor({
											...editor,
											name: e.target.value,
											label: environmentKeyLabel(e.target.value),
											service: environmentService(e.target.value),
										})
									}
								/>
							</label>
							<label className="block space-y-1 text-sm">
								Display name
								<input
									required
									className={input}
									value={editor.label}
									onChange={(e) => setEditor({...editor, label: e.target.value})}
								/>
							</label>
							<label className="block space-y-1 text-sm">
								Service
								<input
									required
									list="environment-services"
									className={input}
									value={editor.service}
									onChange={(e) => setEditor({...editor, service: e.target.value})}
								/>
								<datalist id="environment-services">
									{INTEGRATIONS.map((s) => (
										<option key={s.name} value={s.name} />
									))}
								</datalist>
							</label>
							<label className="block space-y-1 text-sm">
								Value
								<input
									type="password"
									autoComplete="new-password"
									spellCheck={false}
									className={input}
									value={secret}
									placeholder={
										editor.existing ? 'Leave blank to keep the current value' : 'Enter value'
									}
									onChange={(e) => setSecret(e.target.value)}
								/>
							</label>
							<div className="flex justify-between">
								<Button type="submit" disabled={busy}>
									Save key
								</Button>
								{editor.existing && (
									<button
										type="button"
										disabled={busy}
										className="text-sm text-destructive"
										onClick={() => void removeKey()}
									>
										Delete key
									</button>
								)}
							</div>
						</form>
					)}
				</DialogContent>
			</Dialog>
		</AppShell>
	);
}
