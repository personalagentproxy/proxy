import {BotIcon} from 'lucide-react';
import {useState} from 'react';
import type {AgentProvider} from '@/lib/agent-providers';
import {cn} from '@/lib/utils';

export function AgentFavicon({provider, className}: {provider: AgentProvider; className?: string}) {
	const [failed, setFailed] = useState(false);
	if (failed) {
		return (
			<span
				aria-hidden
				className={cn(
					'flex size-5 shrink-0 items-center justify-center rounded-sm bg-muted',
					className,
				)}
			>
				<BotIcon className="size-3.5 text-muted-foreground" />
			</span>
		);
	}

	return (
		<img
			aria-hidden
			src={provider.faviconUrl}
			alt=""
			referrerPolicy="no-referrer"
			className={cn('size-5 shrink-0 rounded-sm object-contain', className)}
			onError={() => setFailed(true)}
		/>
	);
}
