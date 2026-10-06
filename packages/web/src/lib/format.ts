// "Sep 12", with the year once it is not this year's.
export function formatDate(iso: string): string {
	const date = new Date(iso);
	const thisYear = date.getFullYear() === new Date().getFullYear();
	return date.toLocaleDateString('en-US', {
		month: 'short',
		day: 'numeric',
		year: thisYear ? undefined : 'numeric',
	});
}

// "Sep 12, 2:03 PM".
export function formatDateTime(iso: string): string {
	return new Date(iso).toLocaleString('en-US', {
		month: 'short',
		day: 'numeric',
		hour: 'numeric',
		minute: '2-digit',
	});
}

// "Just now", "20m ago", "3h ago", then the date from a week back.
export function formatAgo(iso: string): string {
	const minutes = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
	if (minutes < 1) {
		return 'Just now';
	}

	if (minutes < 60) {
		return `${minutes}m ago`;
	}

	const hours = Math.floor(minutes / 60);
	if (hours < 24) {
		return `${hours}h ago`;
	}

	const days = Math.floor(hours / 24);
	if (days < 7) {
		return `${days}d ago`;
	}

	return formatDate(iso);
}
