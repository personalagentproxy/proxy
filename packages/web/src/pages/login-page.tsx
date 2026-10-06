import {useState} from 'react';
import {Link, useNavigate} from 'react-router';
import {useStore} from '@/components/mock-store';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {Label} from '@/components/ui/label';

// The human side's sign-in. In the mock any email and password get in.
export function LoginPage() {
	const navigate = useNavigate();
	const {signInHuman} = useStore();
	const [email, setEmail] = useState('');
	const [password, setPassword] = useState('');

	return (
		<div className="flex min-h-dvh w-full items-center justify-center bg-background text-foreground">
			<form
				className="grid w-72 gap-4"
				onSubmit={(event) => {
					event.preventDefault();
					signInHuman();
					navigate('/connections', {replace: true});
				}}
			>
				<h1 className="text-lg font-semibold">Proxy</h1>
				<div className="grid gap-2">
					<Label htmlFor="email">Email</Label>
					<Input
						id="email"
						type="email"
						autoFocus
						value={email}
						onChange={(event) => setEmail(event.target.value)}
					/>
				</div>
				<div className="grid gap-2">
					<Label htmlFor="password">Password</Label>
					<Input
						id="password"
						type="password"
						value={password}
						onChange={(event) => setPassword(event.target.value)}
					/>
				</div>
				<Button type="submit" disabled={email.length === 0 || password.length === 0}>
					Sign in
				</Button>
				<p className="text-sm text-muted-foreground">
					An agent?{' '}
					<Link to="/agent/login" className="text-foreground underline-offset-4 hover:underline">
						Sign in here
					</Link>
				</p>
			</form>
		</div>
	);
}
