import {CheckIcon, CopyIcon} from 'lucide-react';
import {useState} from 'react';
import {Button} from '@proxy/ui/components/button';
import {Tooltip, TooltipContent, TooltipTrigger} from '@proxy/ui/components/tooltip';

// Copies `value` and shows a check for a moment, so it is clear the copy happened.
export function CopyButton({value, label}: {value: string; label: string}) {
	const [copied, setCopied] = useState(false);

	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<Button
						variant="ghost"
						size="icon-sm"
						aria-label={label}
						onClick={() => {
							void navigator.clipboard.writeText(value).then(() => {
								setCopied(true);
								setTimeout(() => setCopied(false), 1500);
							});
						}}
					/>
				}
			>
				{copied ? <CheckIcon /> : <CopyIcon />}
			</TooltipTrigger>
			<TooltipContent>{copied ? 'Copied' : label}</TooltipContent>
		</Tooltip>
	);
}
