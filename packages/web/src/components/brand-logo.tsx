import {useState, type ReactNode} from 'react';

import {cn} from '@proxy/ui/lib/utils';

type Props = {
	src?: string;
	fallback: ReactNode;
	className?: string;
	imageClassName?: string;
};

// Brand marks share one neutral tile so transparent and dark-only logos stay legible on every
// surface. The local image is decorative because the adjacent text always names the brand.
export function BrandLogo({src, fallback, className, imageClassName}: Props) {
	const [failed, setFailed] = useState(false);

	return (
		<span
			aria-hidden
			className={cn(
				'flex size-5 shrink-0 items-center justify-center overflow-hidden rounded-md border bg-white shadow-xs',
				className,
			)}
		>
			{!src || failed ? (
				fallback
			) : (
				<img
					src={src}
					alt=""
					className={cn('size-full object-contain p-[2px]', imageClassName)}
					onError={() => setFailed(true)}
				/>
			)}
		</span>
	);
}
