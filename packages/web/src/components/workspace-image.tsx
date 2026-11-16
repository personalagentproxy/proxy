import {useRef, useState} from 'react';
import {Result} from 'ts-results-es';
import {z} from 'zod';
import type {Org} from '@proxy/contracts/orgs';
import {PillButton} from '@proxy/ui/components/pill-button';
import {apiRequest} from '@/client/request';
import {OrgTile} from '@/components/org-switcher';

export function WorkspaceImage({org, onSaved}: {org: Org; onSaved: () => Promise<void>}) {
	const input = useRef<HTMLInputElement>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState('');
	async function save(image: string | null) {
		setBusy(true);
		setError('');
		const result = await apiRequest(
			'PUT',
			`/api/orgs/${org.slug}/image`,
			z.object({ok: z.boolean()}),
			{image},
		);
		setBusy(false);
		if (result.isErr()) {
			setError('Could not save the workspace image. Please try again.');
			return;
		}
		await onSaved();
	}
	async function upload(file: File) {
		if (file.size > 512 * 1024 || !['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
			setError('Choose a PNG, JPEG or WebP image smaller than 512 KB.');
			return;
		}
		const result = await Result.wrapAsync(
			() =>
				new Promise<string>((resolve, reject) => {
					const reader = new FileReader();
					reader.onload = () =>
						typeof reader.result === 'string'
							? resolve(reader.result)
							: reject(new Error('Invalid image'));
					reader.onerror = () => reject(new Error('Could not read image'));
					reader.readAsDataURL(file);
				}),
		);
		if (result.isErr()) {
			setError('Could not read this image.');
			return;
		}
		await save(result.value);
	}
	return (
		<div className="flex flex-col gap-2 py-3">
			<div className="flex flex-wrap items-center gap-3">
				<OrgTile org={org} className="size-12" />
				<div className="flex min-w-40 flex-1 flex-col gap-1">
					<span className="text-sm font-medium">Workspace image</span>
					<span className="text-xs text-muted-foreground">PNG, JPEG or WebP · up to 512 KB</span>
				</div>
				{org.role === 'owner' && (
					<>
						<input
							ref={input}
							type="file"
							className="hidden"
							aria-label="Workspace image"
							accept="image/png,image/jpeg,image/webp"
							disabled={busy}
							onChange={(e) => {
								const file = e.target.files?.[0];
								e.target.value = '';
								if (file) {
									void upload(file);
								}
							}}
						/>
						<PillButton disabled={busy} onClick={() => input.current?.click()}>
							{org.image ? 'Replace image' : 'Upload image'}
						</PillButton>
						{org.image && (
							<PillButton variant="ghost" disabled={busy} onClick={() => void save(null)}>
								Remove
							</PillButton>
						)}
					</>
				)}
			</div>
			{error && (
				<p role="alert" className="text-sm text-destructive">
					{error}
				</p>
			)}
		</div>
	);
}
