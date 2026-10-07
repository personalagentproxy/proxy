import {FileTextIcon, IdCardIcon, MailIcon, NotebookPenIcon, type LucideIcon} from 'lucide-react';
import {
	INTEGRATIONS as CATALOG,
	type Integration as CatalogIntegration,
	type IntegrationId,
} from '@proxy/integrations';

export type Integration = CatalogIntegration & {icon: LucideIcon};

const ICONS: Record<IntegrationId, LucideIcon> = {
	info: IdCardIcon,
	email: MailIcon,
	granola: NotebookPenIcon,
	notion: FileTextIcon,
};

export const INTEGRATIONS: Integration[] = CATALOG.map((integration) => ({
	...integration,
	icon: ICONS[integration.id],
}));

export function findIntegration(id: string): Integration | undefined {
	return INTEGRATIONS.find((integration) => integration.id === id);
}
