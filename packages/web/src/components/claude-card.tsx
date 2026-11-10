import type {ClaudeAccount} from '@proxy/contracts/me';
import {useState} from 'react';
import {Button} from '@proxy/ui/components/button';
import {Input} from '@proxy/ui/components/input';
import {Label} from '@proxy/ui/components/label';
import {
	beginClaudeSignIn,
	connectClaudeToken,
	disconnectClaude,
	finishClaudeSignIn,
} from '@/client/me-client';
import {Section} from '@/components/section';
import {useApply} from '@/hooks/use-apply';
import {describeApiError} from '@/lib/loader-utils';

type Account = ClaudeAccount['account'];

// The Account page's Claude card: the person's own Claude account, which the built-in agent runs
// under for them. Connecting a subscription opens Claude's sign-in in a new tab, which shows a
// code once they agree, pasted back here; a token from `claude setup-token` or an Anthropic API
// key is pasted in its place. Connected, it says how, what is known of the account, when a
// sign-in's token runs out (the server refreshes it), and that a refresh was refused, until they
// connect again.
export function ClaudeCard({account}: {account: Account}) {
	const [error, setError] = useState<string | null>(null);
	// Claude's sign-in page while a sign-in is under way, to open again; null before one begins.
	const [authorizeUrl, setAuthorizeUrl] = useState<string | null>(null);
	const [code, setCode] = useState('');
	const [pasting, setPasting] = useState(false);
	const [token, setToken] = useState('');
	const apply = useApply(setError);

	function reset() {
		setAuthorizeUrl(null);
		setCode('');
		setPasting(false);
		setToken('');
	}

	// The sign-in's page opens in a new tab: in the desktop app, whose window opens no tabs, the
	// app hands any new window to the browser.
	async function connect() {
		const begun = await beginClaudeSignIn();
		if (begun.isErr()) {
			setError(describeApiError(begun.error));
			return;
		}
		setError(null);
		setAuthorizeUrl(begun.value.authorizeUrl);
		window.open(begun.value.authorizeUrl, '_blank', 'noopener');
	}

	const connecting = account === null || account.failure !== null;

	return (
		<Section title="Claude">
			<div className="flex flex-col gap-3 text-sm">
				{account && <Connected account={account} />}
				{connecting && authorizeUrl === null && (
					<div className="flex flex-wrap items-center justify-between gap-3">
						{!account && (
							<p className="text-muted-foreground">
								Run the built-in agent on your own Claude subscription.
							</p>
						)}
						<Button size="sm" onClick={() => void connect()}>
							{account ? 'Connect again' : 'Connect Claude'}
						</Button>
					</div>
				)}
				{connecting && authorizeUrl !== null && (
					<form
						className="flex flex-col gap-2"
						onSubmit={(event) => {
							event.preventDefault();
							void apply(finishClaudeSignIn(code), reset);
						}}
					>
						<Label htmlFor="claude-code">Paste the code from Claude</Label>
						<div className="flex gap-2">
							<Input
								id="claude-code"
								autoComplete="off"
								autoFocus
								value={code}
								onChange={(event) => setCode(event.target.value)}
							/>
							<Button type="submit" size="sm" className="h-9" disabled={code.trim() === ''}>
								Connect
							</Button>
						</div>
						<p className="text-muted-foreground">
							Claude shows the code once you allow Personal Agent Proxy.{' '}
							<a
								href={authorizeUrl}
								target="_blank"
								rel="noopener noreferrer"
								className="underline underline-offset-4"
							>
								Open Claude again
							</a>
						</p>
					</form>
				)}
				{connecting && !pasting && (
					<button
						type="button"
						className="self-start text-muted-foreground underline-offset-4 hover:underline"
						onClick={() => setPasting(true)}
					>
						Paste a setup token or API key instead
					</button>
				)}
				{connecting && pasting && (
					<form
						className="flex flex-col gap-2"
						onSubmit={(event) => {
							event.preventDefault();
							void apply(connectClaudeToken(token), reset);
						}}
					>
						<Label htmlFor="claude-token">Setup token or API key</Label>
						<div className="flex gap-2">
							<Input
								id="claude-token"
								type="password"
								autoComplete="off"
								value={token}
								onChange={(event) => setToken(event.target.value)}
							/>
							<Button type="submit" size="sm" className="h-9" disabled={token.trim() === ''}>
								Connect
							</Button>
						</div>
						<p className="text-muted-foreground">
							A token from <code>claude setup-token</code>, or an Anthropic API key.
						</p>
					</form>
				)}
				{account && (
					<div>
						<Button
							size="sm"
							variant="outline"
							onClick={() => void apply(disconnectClaude(), reset)}
						>
							Disconnect
						</Button>
					</div>
				)}
				{error && <p className="text-destructive">{error}</p>}
			</div>
		</Section>
	);
}

// How the account is connected, what is known of it, and when a sign-in's token runs out.
function Connected({account}: {account: NonNullable<Account>}) {
	const who = [account.email, account.subscriptionType && planOf(account.subscriptionType)].filter(
		(part): part is string => typeof part === 'string' && part !== '',
	);
	return (
		<div className="flex flex-col gap-1">
			<p>Connected with {kindOf(account.kind)}.</p>
			{who.length > 0 && <p className="text-muted-foreground">{who.join(' · ')}</p>}

			{account.failure && <p className="text-destructive">{account.failure}</p>}
		</div>
	);
}

function kindOf(kind: NonNullable<Account>['kind']): string {
	if (kind === 'oauth') {
		return 'a Claude subscription';
	}
	if (kind === 'setup_token') {
		return 'a setup token';
	}
	return 'an API key';
}

// "Max plan" from Claude's name for it.
function planOf(subscriptionType: string): string {
	return `${subscriptionType.charAt(0).toUpperCase()}${subscriptionType.slice(1)} plan`;
}
