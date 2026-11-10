import type {ClaudeAccount} from '@proxy/contracts/me';
import {type ReactNode, useState} from 'react';
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
import {Section} from '@/components/section';
import {useApply} from '@/hooks/use-apply';
import {claudeSignIn, type DesktopClaudeSignIn} from '@/lib/desktop';
import {formatDate, formatDateTime} from '@/lib/format';

type Account = ClaudeAccount['account'];
type Usage = NonNullable<Account>['usage'];
type UsageWindow = NonNullable<Usage>['fiveHour'];

const SETUP_TOKEN_COMMAND = 'claude setup-token';

// How long before the token's end the card says to connect again: a month, so the reminder is
// there well before a conversation stops.
const CONNECT_AGAIN_WITHIN_MS = 30 * 24 * 60 * 60 * 1000;

// The Account page's Claude card: the person's own Claude account, which the built-in agent runs
// under for them. In the desktop app, Connect Claude signs them in to Claude in the browser and
// the app mints a token on their computer from the code they paste back; Paste a token, beside
// it, opens a dialog that takes a token from `claude setup-token` or an Anthropic API key, and is
// all there is in the browser. Connected, it says how, when the token ends where that is known,
// with the ways to connect again as the end nears, that the credential was refused, until they
// connect again, and how much of the plan the last turn found used.
export function ClaudeCard({account}: {account: Account}) {
	const [error, setError] = useState<string | null>(null);
	const [pasting, setPasting] = useState(false);
	const apply = useApply(setError);
	const signIn = claudeSignIn();

	const expiringSoon = account?.expiresAt
		? isWithin(account.expiresAt, CONNECT_AGAIN_WITHIN_MS)
		: false;
	const connecting = account === null || account.failure !== null || expiringSoon;
	// The way to the paste dialog: beside Connect Claude in the desktop app, where it is the
	// alternative, and the one way to connect in the browser.
	const paste = (
		<Button
			type="button"
			size="sm"
			variant={signIn ? 'outline' : 'default'}
			onClick={() => setPasting(true)}
		>
			Paste a token
		</Button>
	);

	return (
		<Section title="Claude">
			<div className="flex flex-col gap-3 text-sm">
				{account && <Connected account={account} expiringSoon={expiringSoon} />}
				{!account && (
					<p className="text-muted-foreground">
						Run the built-in agent on your own Claude subscription.
					</p>
				)}
				{connecting && signIn && (
					<DesktopSignIn
						signIn={signIn}
						setError={setError}
						onToken={(minted, expiresAt) => apply(connectClaudeToken(minted, expiresAt))}
						paste={paste}
					/>
				)}
				{connecting && !signIn && (
					<div className="flex flex-wrap items-center gap-3">
						{paste}
						<p className="text-muted-foreground">Or connect from the desktop app.</p>
					</div>
				)}
				{pasting && <PasteTokenDialog onClose={() => setPasting(false)} />}
				{account && (
					<div>
						<Button size="sm" variant="outline" onClick={() => void apply(disconnectClaude())}>
							Disconnect
						</Button>
					</div>
				)}
				{error && <p className="text-destructive">{error}</p>}
			</div>
		</Section>
	);
}

// The dialog Paste a token opens: the command that makes a token, to copy, and a field for what
// it prints, or for an Anthropic API key. Connect connects it and closes the dialog; what went
// wrong is said in the dialog, which stays for another paste.
function PasteTokenDialog({onClose}: {onClose: () => void}) {
	const [token, setToken] = useState('');
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const apply = useApply(setError);

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
					className="grid gap-5"
					onSubmit={async (event) => {
						event.preventDefault();
						if (busy || token.trim() === '') {
							return;
						}
						setBusy(true);
						await apply(connectClaudeToken(token), onClose);
						setBusy(false);
					}}
				>
					<DialogHeader>
						<DialogTitle>Paste a token</DialogTitle>
						<DialogDescription>
							Run this where Claude Code is installed and paste the token it prints, or paste an
							Anthropic API key, which is billed to that key.
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
							autoComplete="off"
							autoFocus
							value={token}
							onChange={(event) => setToken(event.target.value)}
						/>
					</div>
					{error && <p className="text-sm text-destructive">{error}</p>}
					<DialogFooter>
						<Button type="button" variant="outline" onClick={onClose}>
							Cancel
						</Button>
						<Button type="submit" disabled={busy || token.trim() === ''}>
							{busy ? 'Connecting…' : 'Connect'}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

function isWithin(iso: string, ms: number): boolean {
	return new Date(iso).getTime() - Date.now() <= ms;
}

// The desktop app's sign-in: Connect Claude opens Claude's page in the browser, which shows a
// code once the person has allowed Personal Agent Proxy; pasted here, the app trades it for the
// token, which `onToken` connects. Open Claude again starts over, for a page closed too soon.
// What goes wrong, in the app or at Claude, is said through `setError`; a code refused as
// incomplete or from another attempt leaves the field for another paste. `paste`, the way to
// paste a token instead, sits beside Connect Claude, and beside Open Claude again once the code
// is asked for.
function DesktopSignIn({
	signIn,
	setError,
	onToken,
	paste,
}: {
	signIn: DesktopClaudeSignIn;
	setError: (error: string | null) => void;
	onToken: (token: string, expiresAt: string) => Promise<void>;
	paste: ReactNode;
}) {
	const [code, setCode] = useState('');
	const [opened, setOpened] = useState(false);
	const [busy, setBusy] = useState(false);

	async function open(): Promise<void> {
		setError(null);
		const started = await signIn.start();
		if ('error' in started) {
			setError(started.error);
			return;
		}
		setOpened(true);
	}

	async function connect(): Promise<void> {
		setBusy(true);
		setError(null);
		const finished = await signIn.finish(code);
		if ('error' in finished) {
			setError(finished.error);
			setBusy(false);
			return;
		}
		setCode('');
		setOpened(false);
		await onToken(finished.token, finished.expiresAt);
		setBusy(false);
	}

	if (!opened) {
		return (
			<div className="flex flex-wrap items-center gap-2">
				<Button type="button" size="sm" onClick={() => void open()}>
					Connect Claude
				</Button>
				{paste}
			</div>
		);
	}

	return (
		<form
			className="flex flex-col gap-2"
			onSubmit={(event) => {
				event.preventDefault();
				void connect();
			}}
		>
			<Label htmlFor="claude-code">Paste the code from Claude</Label>
			<div className="flex gap-2">
				<Input
					id="claude-code"
					autoComplete="off"
					value={code}
					onChange={(event) => setCode(event.target.value)}
				/>
				<Button type="submit" size="sm" className="h-9" disabled={busy || code.trim() === ''}>
					Connect
				</Button>
			</div>
			<div className="flex flex-wrap items-center gap-2">
				<Button type="button" size="sm" variant="outline" onClick={() => void open()}>
					Open Claude again
				</Button>
				{paste}
			</div>
		</form>
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
