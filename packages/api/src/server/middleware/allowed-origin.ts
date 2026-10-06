import {env} from '../../utils/env';

export function getAllowedOrigin(): string | null {
	if (!env.APP_URL || !URL.canParse(env.APP_URL)) {
		return null;
	}

	return new URL(env.APP_URL).origin;
}
