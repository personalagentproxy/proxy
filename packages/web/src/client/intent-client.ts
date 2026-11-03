import {
	type FillBody,
	type FilledField,
	filledSchema,
	type NO_WIDGET,
	type PickBody,
	pickedSchema,
	type WidgetId,
} from '@proxy/contracts/intent';
import {apiRequest, orgApi} from '@/client/request';

/** A widget and its fields, as the home page shows it; `none` when no widget does what was asked. */
export type Intent = {widget: WidgetId | typeof NO_WIDGET; fields: FilledField[]};

/** Which widget fits what was typed, in the organization `org` (`POST /api/orgs/:org/intent`). */
export function pickIntent(org: string, text: string) {
	return apiRequest('POST', `${orgApi(org)}/intent`, pickedSchema, {
		text,
	} satisfies PickBody);
}

/** The fields of the widget picked for what was typed, filled in (`POST /api/orgs/:org/intent/fields`). */
export function fillIntent(org: string, text: string, widget: WidgetId) {
	return apiRequest('POST', `${orgApi(org)}/intent/fields`, filledSchema, {
		text,
		widget,
	} satisfies FillBody);
}
