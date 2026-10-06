import {useState} from 'react';
import {Link, useNavigate} from 'react-router';
import {useStore} from '@/components/mock-store';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {Label} from '@/components/ui/label';

// Where an agent signs in with the username and password a human made for it.
export function AgentLoginPage() {
	const navigate = useNavigate();
	const {signInAgent} = useStore();
	const [username, setUsername] = useState('');
	const [password, setPassword] = useState('');
	const [error, setError] = useState<string | null>(null);

	return (
		<div className="flex min-h-dvh w-full items-center justify-center bg-background text-foreground">
			<form
				className="grid w-72 gap-4"
				onSubmit={(event) => {
					event.preventDefault();
					const result = signInAgent(username, password);
					if (result.isErr()) {
						setError(result.error);
						return;
					}
					navigate('/agent', {replace: true});
				}}
			>
				<h1 className="text-lg font-semibold">
					Proxy <span className="font-normal text-muted-foreground">for agents</span>
				</h1>
				<div className="grid gap-2">
					<Label htmlFor="username">Username</Label>
					<Input
						id="username"
						autoFocus
						autoComplete="username"
						value={username}
						onChange={(event) => setUsername(event.target.value)}
					/>
				</div>
				<div className="grid gap-2">
					<Label htmlFor="password">Password</Label>
					<Input
						id="password"
						type="password"
						autoComplete="current-password"
						value={password}
						onChange={(event) => setPassword(event.target.value)}
					/>
				</div>
				{error && <p className="text-sm text-destructive">{error}</p>}
				<Button type="submit" disabled={username.length === 0 || password.length === 0}>
					Sign in
				</Button>
				<p className="text-sm text-muted-foreground">
					Not an agent?{' '}
					<Link to="/login" className="text-foreground underline-offset-4 hover:underline">
						Sign in as yourself
					</Link>
				</p>
			</form>
		</div>
	);
}
