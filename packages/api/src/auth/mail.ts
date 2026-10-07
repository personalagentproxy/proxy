import {Resend} from 'resend';
import {Err, Ok, Result} from 'ts-results-es';

import {type ApiError, ApiErr} from '@proxy/utils';

import {env} from '../utils/env';

// Lazy so the api can boot without RESEND_KEY, which logs the magic link instead (see ./email.ts).
let resendClient: Resend | null = null;

function getResend(): Resend {
	resendClient ??= new Resend(env.RESEND_KEY);
	return resendClient;
}

type SendMagicLinkParams = {
	email: string;
	url: string;
};

export async function sendMagicLink({email, url}: SendMagicLinkParams): Promise<Result<void, ApiError>> {
	if (!env.EMAIL_FROM) {
		return Err(ApiErr.mailError('EMAIL_FROM is not set', null));
	}

	const from = env.EMAIL_FROM;
	const sent = await Result.wrapAsync(() =>
		getResend().emails.send({
			from,
			to: email,
			subject: 'Sign in to Personal Agent Proxy',
			html: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 20px;">
  <p>
    Click the button below to sign in to Personal Agent Proxy:
  </p>
  <p>
    <a href="${url}" style="display: inline-block; background: #18181b; color: white; text-decoration: none; padding: 8px 16px; border-radius: 4px;">Sign in</a>
  </p>
  <p>
    URL to copy: <br />
	${url}
  </p>
  <p>
    If you didn't request this email, you can safely ignore it.
  </p>
</body>
</html>
			`.trim(),
		}),
	);
	if (sent.isErr()) {
		return Err(ApiErr.mailError('Failed to send email', sent.error));
	}

	if (sent.value.error) {
		return Err(ApiErr.mailError(sent.value.error.message, sent.value.error));
	}

	return Ok(undefined);
}
