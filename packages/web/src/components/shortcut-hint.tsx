import {ArrowBigUpIcon, CommandIcon} from 'lucide-react';
import {isApple} from '@/lib/platform';
import {cn} from '@proxy/ui/lib/utils';

/** A shortcut of the platform's: Cmd on a Mac, Ctrl elsewhere, Shift as well where `shift`. */
export type Shortcut = {letter: string; shift?: boolean};

// The keys' icons, at the letter's size, whatever size what they sit in gives its icons.
const KEY_ICON = 'size-3! shrink-0';

/**
 * A shortcut after a label, small and muted, as the platform writes it: "⌘⇧N" on a Mac, its keys
 * drawn as icons, and "Ctrl Shift N" elsewhere. Only seen: what it does is said by the label.
 */
export function ShortcutHint({letter, shift = false, className}: Shortcut & {className?: string}) {
	const key = letter.toUpperCase();
	const style = cn('text-xs text-muted-foreground', className);
	if (!isApple()) {
		return (
			<span aria-hidden className={style}>
				{shift ? `Ctrl Shift ${key}` : `Ctrl ${key}`}
			</span>
		);
	}
	return (
		<span aria-hidden className={cn('inline-flex items-center gap-0.5', style)}>
			<CommandIcon className={KEY_ICON} />
			{shift && <ArrowBigUpIcon className={KEY_ICON} />}
			<span>{key}</span>
		</span>
	);
}
