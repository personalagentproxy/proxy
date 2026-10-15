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

/**
 * Plaid Link, opened from a button: the api makes a Link token, Link opens over the page and signs
 * in to the bank, an OAuth bank in a popup of its own, and answers with a public token for
 * `onLinked`. With `connectionId`, Link signs in again to that connection's bank instead, where
 * there is nothing to exchange.
 */
function usePlaidLinkFlow({
	connectionId,
	onLinked,
}: {
	connectionId?: string;
	onLinked: (publicToken: string) => Promise<string | null>;
}) {
	const [token, setToken] = useState<string | null>(null);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const {open, ready} = usePlaidLink({
		token,
		onSuccess: async (publicToken) => {
			setToken(null);
			setError(publicToken === null ? null : await onLinked(publicToken));
			setPending(false);
		},
		onExit: (exited) => {
			setToken(null);
			setPending(false);
			setError(exited ? (exited.display_message ?? exited.error_message) : null);
		},
	});

	useEffect(() => {
		if (token && ready) {
			open();
		}
	}, [token, ready, open]);

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

	return {start, pending, error};
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
	const {start, pending, error} = usePlaidLinkFlow({
		onLinked: async (publicToken) => {
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
	const {start, pending, error} = usePlaidLinkFlow({
		connectionId,
		onLinked: async () => {
			setDone(true);
			return null;
		},
	});

	return (
		<div className={className}>
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
