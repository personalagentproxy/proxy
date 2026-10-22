import {
	AVATAR_COLORS,
	AVATAR_SHAPES,
	type AvatarColor,
	type AvatarShape,
} from '@proxy/utils/harness';
import {cn} from '@proxy/ui/lib/utils';

// A persona's face: one of four shapes in one of eight colors, as the person picked them. The
// shapes are drawn to fill the same box, so a triangle sits as heavy as a circle beside it.

const FILL: Record<AvatarColor, string> = {
	red: 'fill-avatar-red',
	orange: 'fill-avatar-orange',
	yellow: 'fill-avatar-yellow',
	green: 'fill-avatar-green',
	teal: 'fill-avatar-teal',
	blue: 'fill-avatar-blue',
	purple: 'fill-avatar-purple',
	pink: 'fill-avatar-pink',
};

const BACKGROUND: Record<AvatarColor, string> = {
	red: 'bg-avatar-red',
	orange: 'bg-avatar-orange',
	yellow: 'bg-avatar-yellow',
	green: 'bg-avatar-green',
	teal: 'bg-avatar-teal',
	blue: 'bg-avatar-blue',
	purple: 'bg-avatar-purple',
	pink: 'bg-avatar-pink',
};

const SIZES = {sm: 'size-5', md: 'size-7', lg: 'size-16'} as const;

// Each shape in a 24-unit box, with a little air around it.
function Shape({shape}: {shape: AvatarShape}) {
	if (shape === 'circle') {
		return <circle cx="12" cy="12" r="10" />;
	}
	if (shape === 'square') {
		return <rect x="3" y="3" width="18" height="18" rx="3" />;
	}
	if (shape === 'triangle') {
		return <path d="M12 2.5 22 20.5H2Z" strokeLinejoin="round" />;
	}
	return <path d="M12 1.5 22.5 12 12 22.5 1.5 12Z" strokeLinejoin="round" />;
}

export function Avatar({
	shape,
	color,
	size = 'sm',
	className,
}: {
	shape: AvatarShape;
	color: AvatarColor;
	size?: keyof typeof SIZES;
	className?: string;
}) {
	return (
		<svg
			viewBox="0 0 24 24"
			aria-hidden
			className={cn('shrink-0', SIZES[size], FILL[color], className)}
		>
			<Shape shape={shape} />
		</svg>
	);
}

// Where the person picks a face: the four shapes in a row, in gray, so the shape is read on its
// own, then the eight colors in a row of the same width, with what is picked lit.
export function AvatarPicker({
	shape,
	color,
	onChange,
}: {
	shape: AvatarShape;
	color: AvatarColor;
	onChange: (next: {shape: AvatarShape; color: AvatarColor}) => void;
}) {
	const option =
		'flex items-center justify-center rounded-lg border transition-colors outline-none hover:bg-muted focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50';
	return (
		<div className="flex flex-col gap-1.5">
			<div className="grid grid-cols-4 gap-1.5" role="radiogroup" aria-label="Shape">
				{AVATAR_SHAPES.map((candidate) => (
					<button
						key={candidate}
						type="button"
						role="radio"
						aria-checked={candidate === shape}
						aria-label={candidate}
						onClick={() => onChange({shape: candidate, color})}
						className={cn(
							option,
							'h-16',
							candidate === shape ? 'border-foreground' : 'border-border',
						)}
					>
						<svg
							viewBox="0 0 24 24"
							aria-hidden
							className={cn(
								'size-9',
								candidate === shape ? 'fill-foreground' : 'fill-muted-foreground/60',
							)}
						>
							<Shape shape={candidate} />
						</svg>
					</button>
				))}
			</div>
			<div className="grid grid-cols-8 gap-1.5" role="radiogroup" aria-label="Color">
				{AVATAR_COLORS.map((candidate) => (
					<button
						key={candidate}
						type="button"
						role="radio"
						aria-checked={candidate === color}
						aria-label={candidate}
						onClick={() => onChange({shape, color: candidate})}
						className={cn(
							option,
							'h-9',
							candidate === color ? 'border-foreground' : 'border-border',
						)}
					>
						<span className={cn('size-5 rounded-full', BACKGROUND[candidate])} />
					</button>
				))}
			</div>
		</div>
	);
}
