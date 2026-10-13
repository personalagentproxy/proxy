import type {FetchError} from '@proxy/utils';
import {useState, type ReactNode} from 'react';
import {
	connectTickTick,
	testTickTick,
	type ConnectTickTickInput,
} from '@/client/connections-client';
import {Button} from '@proxy/ui/components/button';
import {Input} from '@proxy/ui/components/input';
import {Label} from '@proxy/ui/components/label';
import {SuccessLine} from '@/components/success-line';
import {apiMessage} from '@/lib/agent-errors';
import type {Connection} from '@/lib/types';

function connectErrorMessage(error: FetchError): string {
	if (error.kind === 'http' && error.status === 422) {
		return 'TickTick turned the token down. Copy it again from TickTick’s settings, or make a new one.';
	}
	if (error.kind === 'http' && error.status === 429) {
		return apiMessage(error.body) ?? 'TickTick is busy. Try again in a minute.';
	}
	if (error.kind === 'http' && error.status === 502) {
		return 'TickTick could not be reached. Try again in a moment.';
	}
	if (error.kind === 'http' && error.status === 409) {
		return 'A TickTick account is already connected by this name.';
	}
	if (error.kind === 'http' && error.status === 400) {
		return apiMessage(error.body) ?? 'Check the name and the token.';
	}
	return 'Something went wrong. Try again.';
}

// The TickTick form: a name to tell the account apart by, since a token doesn't say whose it is,
// and the personal API token from TickTick's settings. Test connection signs in and saves nothing;
// connecting signs in again and saves, so a wrong token shows here and not on an agent's first
// request. After a test that passed, the submit button reads `continueLabel`. `cancel` sits beside
// the buttons.
export function ConnectTickTickForm({
	cancel,
	continueLabel = 'Connect',
	onConnected,
}: {
	cancel?: ReactNode;
	continueLabel?: string;
	onConnected: (connection: Connection) => void;
}) {
	const [account, setAccount] = useState('');
	const [token, setToken] = useState('');
	const [error, setError] = useState<string | null>(null);
	const [pending, setPending] = useState<'test' | 'connect' | null>(null);
	// The values the last passed test signed in with; the test counts while they stay the same.
	const [tested, setTested] = useState<string | null>(null);
	const ready = account.trim() !== '' && token.trim() !== '';
	const input: ConnectTickTickInput = {account, token};
	const passed = tested === JSON.stringify(input);

	const test = async () => {
		setPending('test');
		setError(null);
		const result = await testTickTick(input);
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
				const result = await connectTickTick(input);
				setPending(null);
				if (result.isErr()) {
					setError(connectErrorMessage(result.error));
					return;
				}
				onConnected(result.value);
			}}
		>
			<div className="grid gap-2">
				<Label htmlFor="ticktick-account">Account</Label>
				<Input
					id="ticktick-account"
					placeholder="you@example.com"
					autoComplete="off"
					value={account}
					onChange={(event) => setAccount(event.target.value)}
				/>
				<p className="text-sm text-muted-foreground">
					How this account is shown here and to agents, such as the email you sign in to TickTick
					with.
				</p>
			</div>
			<div className="grid gap-2">
				<Label htmlFor="ticktick-token">API token</Label>
				<Input
					id="ticktick-token"
					type="password"
					autoComplete="off"
					value={token}
					onChange={(event) => setToken(event.target.value)}
				/>
				<p className="text-sm text-muted-foreground">
					In TickTick, Settings, then Account, then API Token. It reaches everything in the account,
					so what agents may do is set here.
				</p>
			</div>
			{error && <p className="text-sm text-destructive">{error}</p>}
			{passed && <SuccessLine>Signed in to TickTick</SuccessLine>}
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
