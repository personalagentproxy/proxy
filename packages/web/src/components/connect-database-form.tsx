import type {FetchError} from '@proxy/utils';
import {useState, type ReactNode} from 'react';
import {
	connectDatabase,
	testDatabase,
	type ConnectDatabaseInput,
	type DatabaseDialect,
} from '@/client/connections-client';
import {Button} from '@proxy/ui/components/button';
import {Input} from '@proxy/ui/components/input';
import {Label} from '@proxy/ui/components/label';
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@proxy/ui/components/select';
import {SuccessLine} from '@/components/success-line';
import {apiMessage} from '@/lib/agent-errors';
import type {Connection} from '@/lib/types';
import {NO_PASSWORD_MANAGER} from '@/lib/password-managers';
import {useCommandEnterSubmit} from '@/hooks/use-command-enter';
import {useOrgSlug} from '@/hooks/use-org';

const DEFAULT_PORT: Record<DatabaseDialect, string> = {postgres: '5432', mysql: '3306'};

const TLS_ITEMS: {value: ConnectDatabaseInput['tls']; label: string}[] = [
	{value: 'verify', label: 'Encrypted, certificate verified'},
	{value: 'require', label: 'Encrypted, any certificate'},
	{value: 'off', label: 'Not encrypted'},
];

function isTlsMode(value: string): value is ConnectDatabaseInput['tls'] {
	return TLS_ITEMS.some((item) => item.value === value);
}

function connectErrorMessage(error: FetchError): string {
	if (error.kind === 'http' && error.status === 422) {
		return 'The database turned the sign-in down. Check the user and the password.';
	}
	if (error.kind === 'http' && error.status === 502) {
		return 'The database could not be reached. Check the host, the port and the encryption, and that the server lets this address in.';
	}
	if (error.kind === 'http' && error.status === 409) {
		return 'This database is already connected as this user.';
	}
	if (error.kind === 'http' && error.status === 400) {
		return apiMessage(error.body) ?? 'Check the host, the port and the database.';
	}
	return 'Something went wrong. Try again.';
}

// The database form: where the server is, the database and the user to sign in as, and whether
// the connection is encrypted. Test connection signs in and saves nothing; connecting signs in
// again and saves, so a wrong password or a host out of reach shows here and not on an agent's
// first request. After a test that passed, the submit button reads `continueLabel`. `cancel` sits
// beside the buttons.
export function ConnectDatabaseForm({
	dialect,
	cancel,
	continueLabel = 'Connect',
	shared,
	onConnected,
}: {
	dialect: DatabaseDialect;
	cancel?: ReactNode;
	continueLabel?: string;
	// For every member of the organization rather than the person's own.
	shared?: boolean;
	onConnected: (connection: Connection) => void;
}) {
	const org = useOrgSlug();
	const [host, setHost] = useState('');
	const [port, setPort] = useState(DEFAULT_PORT[dialect]);
	const [database, setDatabase] = useState('');
	const [username, setUsername] = useState('');
	const [password, setPassword] = useState('');
	const [tls, setTls] = useState<ConnectDatabaseInput['tls']>('verify');
	const [error, setError] = useState<string | null>(null);
	const [pending, setPending] = useState<'test' | 'connect' | null>(null);
	// The values the last passed test signed in with; the test counts while they stay the same.
	const [tested, setTested] = useState<string | null>(null);
	const portNumber = Number(port);
	const ready =
		host.trim() !== '' &&
		Number.isInteger(portNumber) &&
		portNumber > 0 &&
		portNumber < 65536 &&
		database.trim() !== '' &&
		username.trim() !== '';
	const input: ConnectDatabaseInput = {host, port: portNumber, database, username, password, tls};
	const passed = tested === JSON.stringify(input);
	const form = useCommandEnterSubmit(ready && pending === null);

	const test = async () => {
		setPending('test');
		setError(null);
		const result = await testDatabase(org, dialect, input);
		setPending(null);
		if (result.isErr()) {
			setError(connectErrorMessage(result.error));
			return;
		}
		setTested(JSON.stringify(input));
	};

	return (
		<form
			ref={form}
			className="grid gap-4"
			onSubmit={async (event) => {
				event.preventDefault();
				setPending('connect');
				setError(null);
				const result = await connectDatabase(org, dialect, {...input, ...(shared ? {shared} : {})});
				setPending(null);
				if (result.isErr()) {
					setError(connectErrorMessage(result.error));
					return;
				}
				onConnected(result.value);
			}}
		>
			<div className="grid gap-4 sm:grid-cols-[1fr_auto]">
				<div className="grid gap-2">
					<Label htmlFor="database-host">Host</Label>
					<Input
						id="database-host"
						placeholder="db.example.com"
						autoComplete="off"
						value={host}
						onChange={(event) => setHost(event.target.value)}
					/>
				</div>
				<div className="grid gap-2">
					<Label htmlFor="database-port">Port</Label>
					<Input
						id="database-port"
						inputMode="numeric"
						className="sm:w-24"
						autoComplete="off"
						value={port}
						onChange={(event) => setPort(event.target.value)}
					/>
				</div>
			</div>
			<div className="grid gap-2">
				<Label htmlFor="database-name">Database</Label>
				<Input
					id="database-name"
					autoComplete="off"
					value={database}
					onChange={(event) => setDatabase(event.target.value)}
				/>
			</div>
			<div className="grid gap-2">
				<Label htmlFor="database-username">User</Label>
				<Input
					id="database-username"
					{...NO_PASSWORD_MANAGER}
					value={username}
					onChange={(event) => setUsername(event.target.value)}
				/>
				<p className="text-sm text-muted-foreground">
					A user made for this connection, with only the access agents should have: one that can
					only read keeps every query to reading, whatever is ticked here.
				</p>
			</div>
			<div className="grid gap-2">
				<Label htmlFor="database-password">Password</Label>
				<Input
					id="database-password"
					type="password"
					{...NO_PASSWORD_MANAGER}
					value={password}
					onChange={(event) => setPassword(event.target.value)}
				/>
			</div>
			<div className="grid gap-2">
				<Label htmlFor="database-tls">Encryption</Label>
				<Select
					value={tls}
					items={TLS_ITEMS}
					onValueChange={(next) => {
						if (next !== null && isTlsMode(next)) {
							setTls(next);
						}
					}}
				>
					<SelectTrigger id="database-tls" className="w-full">
						<SelectValue />
					</SelectTrigger>
					<SelectContent alignItemWithTrigger={false}>
						{TLS_ITEMS.map((item) => (
							<SelectItem key={item.value} value={item.value}>
								{item.label}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
				<p className="text-sm text-muted-foreground">
					Managed databases have a certificate for their host. A self-signed one needs “any
					certificate”.
				</p>
			</div>
			{error && <p className="text-sm text-destructive">{error}</p>}
			{passed && (
				<SuccessLine>
					Signed in to {database.trim()} on {host.trim()}
				</SuccessLine>
			)}
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
