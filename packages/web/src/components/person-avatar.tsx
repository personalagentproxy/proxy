import {useState} from 'react';
import {cn} from '@proxy/ui/lib/utils';

type Person = {
	name: string | null;
	email: string;
	image: string | null;
};

// A person's Google profile photo when they signed in with one, with their first initial as the
// fallback for email sign-in or an image that can no longer be loaded.
export function PersonAvatar({person, className}: {person: Person; className?: string}) {
	const [failedImage, setFailedImage] = useState<string | null>(null);
	const label = person.name?.trim() || person.email;
	const initial = Array.from(label)[0]?.toUpperCase() ?? '';
	const image = person.image !== failedImage ? person.image : null;

	return (
		<span
			aria-hidden
			data-slot="person-avatar"
			className={cn(
				'relative flex size-7 shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted text-xs',
				className,
			)}
		>
			{initial}
			{image && (
				<img
					alt=""
					src={image}
					loading="lazy"
					decoding="async"
					referrerPolicy="no-referrer"
					className="absolute inset-0 size-full bg-muted object-cover"
					onError={() => setFailedImage(image)}
				/>
			)}
		</span>
	);
}
