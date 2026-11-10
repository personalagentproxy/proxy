import type {ClaudeAccount} from '@proxy/contracts/me';
import {useState} from 'react';
import {Button} from '@proxy/ui/components/button';
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@proxy/ui/components/dialog';
import {Input} from '@proxy/ui/components/input';
import {Label} from '@proxy/ui/components/label';
import {connectClaudeToken, disconnectClaude} from '@/client/me-client';
import {CopyButton} from '@/components/copy-button';
import {DesktopUpdateCheck} from '@/components/desktop-update-check';
import {Section} from '@/components/section';
import {useApply} from '@/hooks/use-apply';
import {claudeSignIn, isDesktopApp, type DesktopClaudeSignIn} from '@/lib/desktop';
import {formatDate, formatDateTime} from '@/lib/format';
import {NO_PASSWORD_MANAGER} from '@/lib/password-managers';

type Account = ClaudeAccount['account'];
type Usage = NonNullable<Account>['usage'];
type UsageWindow = NonNullable<Usage>['fiveHour'];

const SETUP_TOKEN_COMMAND = 'claude setup-token';

// How long before the token's end the card says to connect again: a month, so the reminder is
// there well before a conversation stops.
const CONNECT_AGAIN_WITHIN_MS = 30 * 24 * 60 * 60 * 1000;

// The Account page's Claude card: the person's own Claude account, which the built-in agent runs
// under for them. Not connected, or to connect again, it offers the ways to, each in a dialog: in
// the desktop app, Connect Claude signs them in to Claude in the browser and the app mints a token
// on their computer from the code they paste back; everywhere, Paste a token takes one from
// `claude setup-token` or an Anthropic API key. In the browser, it points to the desktop app; in
// a desktop app from before the sign-in, to the update that brings it. Connected, it says how,
// when the token ends where that is known, with the way to connect again as the end nears, that
// the credential was refused, until they connect again, and how much of the plan the last turn
// found used.
export function ClaudeCard({account}: {account: Account}) {
	const [error, setError] = useState<string | null>(null);
	const [dialog, setDialog] = useState<'sign-in' | 'paste' | null>(null);
	const apply = useApply(setError);
	const signIn = claudeSignIn();
	const desktop = isDesktopApp();

	const expiringSoon = account?.expiresAt
		? isWithin(account.expiresAt, CONNECT_AGAIN_WITHIN_MS)
		: false;
	const connecting = account === null || account.failure !== null || expiringSoon;

	// Claude's page opens in the browser before the dialog asks for its code; one that could not
	// be opened is said on the card.
	async function startSignIn(signIn: DesktopClaudeSignIn): Promise<void> {
		setError(null);
		const started = await signIn.start();
		if ('error' in started) {
			setError(started.error);
			return;
		}
		setDialog('sign-in');
	}

	return (
		<Section title="Claude">
			<div className="flex flex-col gap-3 text-sm">
				{account && <Connected account={account} expiringSoon={expiringSoon} />}
				{!account && (
					<p className="text-muted-foreground">
						Run the built-in agent on your own Claude subscription.
					</p>
				)}
				<div className="flex flex-wrap gap-2">
					{connecting && signIn && (
						<Button type="button" size="sm" onClick={() => void startSignIn(signIn)}>
							Connect Claude
						</Button>
					)}
					{connecting && (
						<Button
							type="button"
							size="sm"
							variant={signIn ? 'outline' : 'default'}
							onClick={() => setDialog('paste')}
						>
							Paste a token
						</Button>
					)}
					{account && (
						<Button
							type="button"
							size="sm"
							variant="outline"
							onClick={() => void apply(disconnectClaude())}
						>
							Disconnect
						</Button>
					)}
				</div>
				{connecting && !desktop && (
					<p className="text-muted-foreground">Or sign in with Claude from the desktop app.</p>
				)}
				{connecting && desktop && !signIn && (
					<div className="flex flex-col gap-2">
						<p className="text-muted-foreground">
							An update to the desktop app lets you sign in with Claude here.
						</p>
						<DesktopUpdateCheck />
					</div>
				)}
				{error && <p className="text-destructive">{error}</p>}
			</div>
			{dialog === 'paste' && <PasteTokenDialog onClose={() => setDialog(null)} />}
			{dialog === 'sign-in' && signIn && (
				<SignInDialog signIn={signIn} onClose={() => setDialog(null)} />
			)}
		</Section>
	);
}

function isWithin(iso: string, ms: number): boolean {
	return new Date(iso).getTime() - Date.now() <= ms;
}

// A token from `claude setup-token`, the command shown to copy, or an Anthropic API key, pasted
// and connected as it is.
function PasteTokenDialog({onClose}: {onClose: () => void}) {
	const [token, setToken] = useState('');
	const [error, setError] = useState<string | null>(null);
	const [pending, setPending] = useState(false);
	const apply = useApply(setError);
	const ready = token.trim() !== '';

	return (
		<Dialog
			open
			onOpenChange={(next) => {
				if (next) {
					return;
				}
				onClose();
			}}
		>
			<DialogContent>
				<form
					className="grid gap-4"
					onSubmit={async (event) => {
						event.preventDefault();
						if (!ready) {
							return;
						}
						setPending(true);
						await apply(connectClaudeToken(token.trim()), onClose);
						setPending(false);
					}}
				>
					<DialogHeader>
						<DialogTitle>Paste a Claude token</DialogTitle>
						<DialogDescription>
							Run this in a terminal and sign in, then paste the token it prints. An Anthropic API
							key works too.
						</DialogDescription>
					</DialogHeader>
					<div className="flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm">
						<span className="min-w-0 flex-1 truncate font-mono">{SETUP_TOKEN_COMMAND}</span>
						<CopyButton value={SETUP_TOKEN_COMMAND} label="Copy command" />
					</div>
					<div className="grid gap-2">
						<Label htmlFor="claude-token">Token or API key</Label>
						<Input
							id="claude-token"
							type="password"
							autoFocus
							{...NO_PASSWORD_MANAGER}
							value={token}
							onChange={(event) => setToken(event.target.value)}
						/>
					</div>
					{error && <p className="text-sm text-destructive">{error}</p>}
					<DialogFooter>
						<Button type="button" variant="outline" onClick={onClose}>
							Cancel
						</Button>
						<Button type="submit" disabled={!ready || pending}>
							Connect
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

// The desktop app's sign-in, once Claude's page is open in the browser: it shows a code once the
// person has allowed Personal Agent Proxy, which, pasted here, the app trades for the token, then
// connected. Open Claude again starts over, for a page closed too soon. A code refused as
// incomplete or from another attempt is said, and leaves the field for another paste.
function SignInDialog({signIn, onClose}: {signIn: DesktopClaudeSignIn; onClose: () => void}) {
	const [code, setCode] = useState('');
	const [error, setError] = useState<string | null>(null);
	const [pending, setPending] = useState(false);
	const apply = useApply(setError);
	const ready = code.trim() !== '';

	async function reopen(): Promise<void> {
		setError(null);
		const started = await signIn.start();
		if ('error' in started) {
			setError(started.error);
		}
	}

	async function connect(): Promise<void> {
		setPending(true);
		setError(null);
		const finished = await signIn.finish(code);
		if ('error' in finished) {
			setError(finished.error);
			setPending(false);
			return;
		}
		await apply(connectClaudeToken(finished.token, finished.expiresAt), onClose);
		setPending(false);
	}

	return (
		<Dialog
			open
			onOpenChange={(next) => {
				if (next) {
					return;
				}
				onClose();
			}}
		>
			<DialogContent>
				<form
					className="grid gap-4"
					onSubmit={(event) => {
						event.preventDefault();
						if (!ready) {
							return;
						}
						void connect();
					}}
				>
					<DialogHeader>
						<DialogTitle>Connect Claude</DialogTitle>
						<DialogDescription>
							Claude opened in your browser. Allow Personal Agent Proxy there, then paste the code
							Claude shows.
						</DialogDescription>
					</DialogHeader>
					<div className="grid gap-2">
						<Label htmlFor="claude-code">Paste the code from Claude</Label>
						<Input
							id="claude-code"
							autoFocus
							{...NO_PASSWORD_MANAGER}
							value={code}
							onChange={(event) => setCode(event.target.value)}
						/>
					</div>
					{error && <p className="text-sm text-destructive">{error}</p>}
					<DialogFooter className="sm:justify-between">
						<Button type="button" variant="ghost" onClick={() => void reopen()}>
							Open Claude again
						</Button>
						<div className="flex flex-col-reverse gap-2 sm:flex-row">
							<Button type="button" variant="outline" onClick={onClose}>
								Cancel
							</Button>
							<Button type="submit" disabled={!ready || pending}>
								Connect
							</Button>
						</div>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

// How the account is connected, when the token ends, whether it was refused, and the plan's usage.
function Connected({
	account,
	expiringSoon,
}: {
	account: NonNullable<Account>;
	expiringSoon: boolean;
}) {
	return (
		<div className="flex flex-col gap-1">
			<p>Connected with {account.kind === 'setup_token' ? 'a Claude token' : 'an API key'}.</p>
			{account.expiresAt && (
				<p className={expiringSoon ? 'text-destructive' : 'text-muted-foreground'}>
					Signed in until {formatDate(account.expiresAt)}.{expiringSoon && ' Connect again soon.'}
				</p>
			)}
			{account.failure && <p className="text-destructive">{account.failure}</p>}
			{account.usage && <UsageLines usage={account.usage} />}
		</div>
	);
}

// What the model's provider said of the plan as the last turn ran: each window it spoke of, and
// when that was.
function UsageLines({usage}: {usage: NonNullable<Usage>}) {
	return (
		<div className="text-muted-foreground">
			{usage.fiveHour && <p>5-hour window: {describeWindow(usage.fiveHour)}</p>}
			{usage.sevenDay && <p>7-day window: {describeWindow(usage.sevenDay)}</p>}
			<p>As of {formatDateTime(usage.readAt)}.</p>
		</div>
	);
}

// "37% used, resets Nov 10, 3:00 PM".
function describeWindow(window: NonNullable<UsageWindow>): string {
	const used = `${Math.round(window.utilization * 100)}% used`;
	if (window.resetsAt === null) {
		return used;
	}
	return `${used}, resets ${formatDateTime(window.resetsAt)}`;
}
