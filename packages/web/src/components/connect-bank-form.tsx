import type {FetchError} from '@proxy/utils';
import {Button} from '@proxy/ui/components/button';
import {useEffect, useState, type ReactNode} from 'react';
import {usePlaidLink} from 'react-plaid-link';
import {connectPlaid, createPlaidLinkToken} from '@/client/connections-client';
import {SuccessLine} from '@/components/success-line';
import {apiMessage} from '@/lib/agent-errors';
import type {Connection} from '@/lib/types';

function plaidErrorMessage(error: FetchError): string {
	if (error.kind === 'http' && error.status === 400) {
		return apiMessage(error.body) ?? 'Plaid turned the request down. Try again.';
	}
	if (error.kind === 'http' && error.status === 502) {
		return 'Plaid or the bank could not be reached. Try again in a moment.';
	}
	return 'Something went wrong. Try again.';
}

// Plaid Link for a token, opened as soon as Plaid's script has loaded. It is only mounted once the
// api has made a token, so a page with the button doesn't load Plaid's script until it is pressed.
function OpenPlaidLink({
	token,
	onSuccess,
	onExit,
}: {
	token: string;
	// react-plaid-link types the public token as possibly missing.
	onSuccess: (publicToken: string | null) => void;
	onExit: (message: string | null) => void;
}) {
	const {open, ready} = usePlaidLink({
		token,
		onSuccess,
		onExit: (exited) => onExit(exited ? (exited.display_message ?? exited.error_message) : null),
	});

	useEffect(() => {
		if (ready) {
			open();
		}
	}, [ready, open]);

	return null;
}

/**
 * Plaid Link, opened from a button: the api makes a Link token, Link opens over the page and signs
 * in to the bank, an OAuth bank in a popup of its own, and answers with a public token for
 * `onLinked`. With `connectionId`, Link signs in again to that connection's bank instead, where
 * there is nothing to exchange. `link` is rendered beside the button.
 */
function usePlaidLinkFlow({
	connectionId,
	onLinked,
}: {
	connectionId?: string;
	onLinked: (publicToken: string | null) => Promise<string | null>;
}) {
	const [token, setToken] = useState<string | null>(null);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const start = async () => {
		setPending(true);
		setError(null);
		const result = await createPlaidLinkToken(connectionId);
		if (result.isErr()) {
			setPending(false);
			setError(plaidErrorMessage(result.error));
			return;
		}
		setToken(result.value.linkToken);
	};

	const link = token !== null && (
		<OpenPlaidLink
			token={token}
			onSuccess={async (publicToken) => {
				setToken(null);
				setError(await onLinked(publicToken));
				setPending(false);
			}}
			onExit={(message) => {
				setToken(null);
				setPending(false);
				setError(message);
			}}
		/>
	);

	return {start, pending, error, link};
}

// Connecting a bank: Plaid Link chooses the bank, signs in to it and asks which accounts to share,
// then the api keeps the login as a new connection. `cancel` sits beside the button.
export function ConnectBankForm({
	cancel,
	onConnected,
}: {
	cancel?: ReactNode;
	onConnected: (connection: Connection) => void;
}) {
	const {start, pending, error, link} = usePlaidLinkFlow({
		onLinked: async (publicToken) => {
			if (publicToken === null) {
				return 'Plaid didn’t answer with the bank’s login. Try again.';
			}
			const result = await connectPlaid(publicToken);
			if (result.isErr()) {
				return plaidErrorMessage(result.error);
			}
			onConnected(result.value);
			return null;
		},
	});

	return (
		<div className="grid gap-4">
			{link}
			{error && <p className="text-sm text-destructive">{error}</p>}
			<div className="flex justify-end gap-2">
				{cancel}
				<Button disabled={pending} onClick={() => void start()}>
					{pending ? 'Opening Plaid…' : 'Choose your bank'}
				</Button>
			</div>
		</div>
	);
}

// Signing in to a connected bank again, when it asks for its login again or to share other
// accounts: Plaid Link's update mode on the same login, which keeps the connection as it is.
export function SignInToBankAgain({
	connectionId,
	className,
}: {
	connectionId: string;
	className?: string;
}) {
	const [done, setDone] = useState(false);
	const {start, pending, error, link} = usePlaidLinkFlow({
		connectionId,
		onLinked: async () => {
			setDone(true);
			return null;
		},
	});

	return (
		<div className={className}>
			{link}
			<p className="text-sm text-muted-foreground">
				When the bank asks for its login again, or to share other accounts:{' '}
				<button
					type="button"
					disabled={pending}
					className="text-foreground underline underline-offset-4 disabled:opacity-50"
					onClick={() => {
						setDone(false);
						void start();
					}}
				>
					{pending ? 'Opening Plaid…' : 'Sign in to the bank again'}
				</button>
			</p>
			{done && (
				<div className="mt-2">
					<SuccessLine>Signed in to the bank again</SuccessLine>
				</div>
			)}
			{error && <p className="mt-2 text-sm text-destructive">{error}</p>}
		</div>
	);
}
