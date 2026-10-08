import {EMAIL_PROVIDERS, type EmailProvider} from '@proxy/integrations';
import type {FetchError} from '@proxy/utils';
import {useState, type ReactNode} from 'react';
import {connectEmail, testEmail, type ConnectEmailInput} from '@/client/connections-client';
import {Button} from '@proxy/ui/components/button';
import {Input} from '@proxy/ui/components/input';
import {Label} from '@proxy/ui/components/label';
import {SuccessLine} from '@/components/success-line';
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@proxy/ui/components/select';
import type {Connection} from '@/lib/types';

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

// The mailbox form: provider, address and app password, and the servers where the provider has
// none built in. Test connection signs in to the mailbox and saves nothing; connecting signs in
// again and saves, so a wrong password shows here and not on an agent's first request. After a
// test that passed, the submit button reads `continueLabel`. `cancel` sits beside the buttons.
export function ConnectEmailForm({
	cancel,
	continueLabel = 'Connect',
	onConnected,
}: {
	cancel?: ReactNode;
	continueLabel?: string;
	onConnected: (connection: Connection) => void;
}) {
	const [providerId, setProviderId] = useState<EmailProvider['id']>('gmail');
	const [email, setEmail] = useState('');
	const [password, setPassword] = useState('');
	const [imapHost, setImapHost] = useState('');
	const [smtpHost, setSmtpHost] = useState('');
	const [smtpPort, setSmtpPort] = useState<'465' | '587'>('465');
	const [error, setError] = useState<string | null>(null);
	const [pending, setPending] = useState<'test' | 'connect' | null>(null);
	// The values the last passed test signed in with; the test counts while they stay the same.
	const [tested, setTested] = useState<string | null>(null);
	const provider = EMAIL_PROVIDERS.find((candidate) => candidate.id === providerId);
	const typesServers = provider?.servers === null;
	const ready =
		email.trim() !== '' &&
		password !== '' &&
		(!typesServers || (imapHost.trim() !== '' && smtpHost.trim() !== ''));
	const input: ConnectEmailInput = {
		provider: providerId,
		email,
		password,
		...(typesServers
			? {servers: {imapHost, smtpHost, smtpPort: smtpPort === '465' ? 465 : 587}}
			: {}),
	};
	const passed = tested === JSON.stringify(input);

	const test = async () => {
		setPending('test');
		setError(null);
		const result = await testEmail(input);
		setPending(null);
		if (result.isErr()) {
			setError(connectErrorMessage(result.error));
			return;
		}
		setTested(JSON.stringify(input));
	};

	return (
		<form
			className="grid gap-4"
			onSubmit={async (event) => {
				event.preventDefault();
				setPending('connect');
				setError(null);
				const result = await connectEmail(input);
				setPending(null);
				if (result.isErr()) {
					setError(connectErrorMessage(result.error));
					return;
				}
				onConnected(result.value);
			}}
		>
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
					<p className="text-sm text-muted-foreground">
						<a
							href={provider.appPasswordUrl}
							target="_blank"
							rel="noreferrer"
							className="text-foreground underline underline-offset-4"
						>
							Make an app password
						</a>
						{provider.id === 'gmail' && ', which needs 2-Step Verification on the Google account'}.
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
			{passed && <SuccessLine>Signed in to {email.trim()}</SuccessLine>}
			<div className="flex justify-end gap-2">
				{cancel}
				<Button
					type="button"
					variant="outline"
					disabled={!ready || pending !== null}
					onClick={() => void test()}
				>
					{pending === 'test' ? 'Testing…' : 'Test connection'}
				</Button>
				<Button type="submit" disabled={!ready || pending !== null}>
					{pending === 'connect' ? 'Signing in…' : passed ? continueLabel : 'Connect'}
				</Button>
			</div>
		</form>
	);
}
