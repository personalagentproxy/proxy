import {useState, type FormEvent} from 'react';
import {Link, useSearchParams} from 'react-router';
import {devLogin, googleSignInUrl, requestMagicLink} from '@/client/auth-client';
import {GoogleIcon} from '@/components/google-icon';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {Label} from '@/components/ui/label';
import {sanitizeCallbackUrl} from '@/lib/callback-url';
import {env} from '@/lib/env';

// The api's sign-in errors, from the `error` param of a redirect or the magic-link response.
const errorMessages: Record<string, string> = {
	Callback: 'There was an error during sign in. Please try again.',
	OAuthSignin: 'Could not start the sign in process. Please try again.',
	OAuthCallback: 'Could not complete sign in with Google. Please try again.',
	OAuthCreateAccount: 'Could not create an account with Google. Please try again.',
	OAuthAccountNotLinked: 'This email already has an account. Sign in with a magic link instead.',
	EmailSignin: 'Could not send the sign-in email. Please try again.',
	Verification: 'This sign-in link is invalid or has expired. Please request a new one.',
};

function errorMessage(code: string | undefined): string {
	return (code && errorMessages[code]) || 'An unexpected error occurred. Please try again.';
}

type Status =
	{kind: 'idle'} | {kind: 'sending'} | {kind: 'sent'} | {kind: 'error'; message: string};

// The human side's sign-in: Google, or a magic link to the email address. Both come back with a
// session cookie and land on `callbackUrl`, the page the user was sent here from.
export function LoginPage() {
	const [searchParams] = useSearchParams();
	const redirectError = searchParams.get('error');
	const callbackUrl = sanitizeCallbackUrl(searchParams.get('callbackUrl'));
	const [email, setEmail] = useState('');
	const [status, setStatus] = useState<Status>({kind: 'idle'});

	async function onSubmit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const trimmed = email.trim();
		if (status.kind === 'sending' || trimmed.length === 0) {
			return;
		}
		setStatus({kind: 'sending'});

		const result = await requestMagicLink(trimmed, callbackUrl);
		if (result.isErr()) {
			setStatus({kind: 'error', message: errorMessage(undefined)});
			return;
		}

		if (!result.value.ok) {
			setStatus({kind: 'error', message: errorMessage(result.value.error)});
			return;
		}

		setStatus({kind: 'sent'});
	}

	return (
		<div className="flex min-h-dvh w-full items-center justify-center bg-background text-foreground">
			<div className="grid w-72 gap-4">
				<h1 className="text-lg font-semibold">Proxy</h1>
				{redirectError && status.kind === 'idle' && (
					<p className="text-sm text-destructive">{errorMessage(redirectError)}</p>
				)}
				<Button
					variant="outline"
					onClick={() => {
						window.location.href = googleSignInUrl(callbackUrl);
					}}
				>
					<GoogleIcon />
					Continue with Google
				</Button>
				<p className="text-center text-sm text-muted-foreground">or</p>
				<form className="grid gap-4" onSubmit={(event) => void onSubmit(event)}>
					<div className="grid gap-2">
						<Label htmlFor="email">Email</Label>
						<Input
							id="email"
							type="email"
							autoComplete="email"
							value={email}
							onChange={(event) => setEmail(event.target.value)}
						/>
					</div>
					<Button type="submit" disabled={email.trim().length === 0 || status.kind === 'sending'}>
						Send sign-in link
					</Button>
					{status.kind === 'sent' && (
						<p className="text-sm text-muted-foreground">Check your email for a link to sign in.</p>
					)}
					{status.kind === 'error' && <p className="text-sm text-destructive">{status.message}</p>}
				</form>
				{env.isDev && <DevLoginButton callbackUrl={callbackUrl} />}
				<p className="text-sm text-muted-foreground">
					An agent?{' '}
					<Link to="/agent/login" className="text-foreground underline-offset-4 hover:underline">
						Sign in here
					</Link>
				</p>
			</div>
		</div>
	);
}

// Development only: a fresh throwaway user, signed in at once, without Google or an email.
function DevLoginButton({callbackUrl}: {callbackUrl: string | undefined}) {
	const [loading, setLoading] = useState(false);

	return (
		<Button
			variant="secondary"
			disabled={loading}
			onClick={async () => {
				setLoading(true);
				const result = await devLogin();
				if (result.isErr()) {
					setLoading(false);
					return;
				}
				window.location.href = callbackUrl ?? '/';
			}}
		>
			Create dev user
		</Button>
	);
}
