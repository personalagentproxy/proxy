import {EMAIL_PROVIDERS, type EmailProvider} from '@proxy/integrations';
import type {FetchError} from '@proxy/utils';
import {useState} from 'react';
import {useNavigate} from 'react-router';
import {connectEmail} from '@/client/connections-client';
import {AppShell, PageTitle} from '@/components/app-shell';
import {BackButton} from '@/components/back-button';
import {RowList} from '@/components/row-list';
import {Button} from '@/components/ui/button';
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@/components/ui/dialog';
import {Input} from '@/components/ui/input';
import {Label} from '@/components/ui/label';
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@/components/ui/select';
import {INTEGRATIONS} from '@/lib/integrations';

// The catalog. Email is the only integration for now; it can be connected again for another
// mailbox.
export function AddConnectionPage() {
	const [connecting, setConnecting] = useState(false);
	const available = INTEGRATIONS.filter((integration) => !integration.builtIn);

	return (
		<AppShell
			title={
				<>
					<BackButton to="/connections" label="Back to connections" />
					<PageTitle>Add connection</PageTitle>
				</>
			}
		>
			<RowList>
				{available.map((integration) => (
					<li
						key={integration.id}
						className="flex min-h-14 items-center gap-3 px-4 py-2 text-sm md:px-3"
					>
						<integration.icon className="size-4 shrink-0 text-muted-foreground" />
						<div className="grid min-w-0 flex-1">
							<span className="truncate">{integration.name}</span>
							<span className="truncate text-xs text-muted-foreground">
								{integration.description}
							</span>
						</div>
						<Button size="sm" variant="outline" onClick={() => setConnecting(true)}>
							Connect
						</Button>
					</li>
				))}
			</RowList>
			<ConnectEmailDialog open={connecting} onClose={() => setConnecting(false)} />
		</AppShell>
	);
}

const PROVIDER_ITEMS = EMAIL_PROVIDERS.map((provider) => ({
	value: provider.id,
	label: provider.name,
}));

const SMTP_PORT_ITEMS = [
	{value: '465', label: '465 (TLS)'},
	{value: '587', label: '587 (STARTTLS)'},
];

function isProviderId(value: string): value is EmailProvider['id'] {
	return EMAIL_PROVIDERS.some((provider) => provider.id === value);
}

function connectErrorMessage(error: FetchError): string {
	if (error.kind === 'http' && error.status === 422) {
		return 'The mailbox turned the password down. Check the address and the app password.';
	}
	if (error.kind === 'http' && error.status === 502) {
		return 'The mail server could not be reached. Check the servers and try again.';
	}
	if (error.kind === 'http' && error.status === 409) {
		return 'This mailbox is already connected.';
	}
	if (error.kind === 'http' && error.status === 400) {
		return 'Check the address and the servers.';
	}
	return 'Something went wrong. Try again.';
}

// Signs in to the mailbox before anything is saved, so a wrong password shows here and not on an
// agent's first request.
function ConnectEmailDialog({open, onClose}: {open: boolean; onClose: () => void}) {
	const navigate = useNavigate();
	const [providerId, setProviderId] = useState<EmailProvider['id']>('gmail');
	const [email, setEmail] = useState('');
	const [password, setPassword] = useState('');
	const [imapHost, setImapHost] = useState('');
	const [smtpHost, setSmtpHost] = useState('');
	const [smtpPort, setSmtpPort] = useState<'465' | '587'>('465');
	const [error, setError] = useState<string | null>(null);
	const [pending, setPending] = useState(false);
	const provider = EMAIL_PROVIDERS.find((candidate) => candidate.id === providerId);
	const typesServers = provider?.servers === null;
	const ready =
		email.trim() !== '' &&
		password !== '' &&
		(!typesServers || (imapHost.trim() !== '' && smtpHost.trim() !== ''));

	const close = () => {
		setPassword('');
		setError(null);
		onClose();
	};

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				if (next) {
					return;
				}
				close();
			}}
		>
			<DialogContent>
				<form
					className="grid gap-4"
					onSubmit={async (event) => {
						event.preventDefault();
						setPending(true);
						setError(null);
						const result = await connectEmail({
							provider: providerId,
							email,
							password,
							...(typesServers
								? {servers: {imapHost, smtpHost, smtpPort: smtpPort === '465' ? 465 : 587}}
								: {}),
						});
						setPending(false);
						if (result.isErr()) {
							setError(connectErrorMessage(result.error));
							return;
						}
						close();
						navigate(`/connections/${result.value.id}`);
					}}
				>
					<DialogHeader>
						<DialogTitle>Connect a mailbox</DialogTitle>
						<DialogDescription>
							Proxy signs in with an app password, made for Proxy alone in your mail account.
							Revoking it there disconnects Proxy.
						</DialogDescription>
					</DialogHeader>
					<div className="grid gap-2">
						<Label htmlFor="email-provider">Provider</Label>
						<Select
							value={providerId}
							items={PROVIDER_ITEMS}
							onValueChange={(next) => {
								if (next !== null && isProviderId(next)) {
									setProviderId(next);
								}
							}}
						>
							<SelectTrigger id="email-provider" className="w-full">
								<SelectValue />
							</SelectTrigger>
							<SelectContent alignItemWithTrigger={false}>
								{PROVIDER_ITEMS.map((item) => (
									<SelectItem key={item.value} value={item.value}>
										{item.label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>
					<div className="grid gap-2">
						<Label htmlFor="email-address">Email address</Label>
						<Input
							id="email-address"
							type="email"
							autoComplete="off"
							value={email}
							onChange={(event) => setEmail(event.target.value)}
						/>
					</div>
					<div className="grid gap-2">
						<Label htmlFor="email-password">App password</Label>
						<Input
							id="email-password"
							type="password"
							autoComplete="off"
							value={password}
							onChange={(event) => setPassword(event.target.value)}
						/>
						{provider?.appPasswordUrl && (
							<p className="text-xs text-muted-foreground">
								<a
									href={provider.appPasswordUrl}
									target="_blank"
									rel="noreferrer"
									className="text-foreground underline underline-offset-4"
								>
									Make an app password
								</a>
								{provider.id === 'gmail' &&
									', which needs 2-Step Verification on the Google account'}
								.
							</p>
						)}
					</div>
					{typesServers && (
						<div className="grid gap-2">
							<Label htmlFor="imap-host">IMAP server</Label>
							<Input
								id="imap-host"
								placeholder="imap.example.com"
								value={imapHost}
								onChange={(event) => setImapHost(event.target.value)}
							/>
						</div>
					)}
					{typesServers && (
						<div className="grid gap-4 sm:grid-cols-[1fr_auto]">
							<div className="grid gap-2">
								<Label htmlFor="smtp-host">SMTP server</Label>
								<Input
									id="smtp-host"
									placeholder="smtp.example.com"
									value={smtpHost}
									onChange={(event) => setSmtpHost(event.target.value)}
								/>
							</div>
							<div className="grid gap-2">
								<Label htmlFor="smtp-port">SMTP port</Label>
								<Select
									value={smtpPort}
									items={SMTP_PORT_ITEMS}
									onValueChange={(next) => {
										if (next === '465' || next === '587') {
											setSmtpPort(next);
										}
									}}
								>
									<SelectTrigger id="smtp-port" className="w-full">
										<SelectValue />
									</SelectTrigger>
									<SelectContent alignItemWithTrigger={false}>
										{SMTP_PORT_ITEMS.map((item) => (
											<SelectItem key={item.value} value={item.value}>
												{item.label}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</div>
						</div>
					)}
					{error && <p className="text-sm text-destructive">{error}</p>}
					<DialogFooter>
						<Button type="button" variant="outline" onClick={close}>
							Cancel
						</Button>
						<Button type="submit" disabled={!ready || pending}>
							{pending ? 'Signing in…' : 'Connect'}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
