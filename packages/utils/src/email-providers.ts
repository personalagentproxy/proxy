// Where a mailbox's servers are. IMAP is always TLS on 993; SMTP is TLS on 465 or STARTTLS on 587.
export type MailServers = {imapHost: string; smtpHost: string; smtpPort: 465 | 587};

export type EmailProvider = {
	id: 'gmail' | 'icloud' | 'fastmail' | 'yahoo' | 'other';
	name: string;
	// Null for Other, where the servers are typed in.
	servers: MailServers | null;
	// Where the app password is made, when the provider has one page for it.
	appPasswordUrl?: string;
};

export const EMAIL_PROVIDERS: EmailProvider[] = [
	{
		id: 'gmail',
		name: 'Gmail or Google Workspace',
		servers: {imapHost: 'imap.gmail.com', smtpHost: 'smtp.gmail.com', smtpPort: 465},
		appPasswordUrl: 'https://myaccount.google.com/apppasswords',
	},
	{
		id: 'icloud',
		name: 'iCloud',
		servers: {imapHost: 'imap.mail.me.com', smtpHost: 'smtp.mail.me.com', smtpPort: 587},
		appPasswordUrl: 'https://account.apple.com/account/manage',
	},
	{
		id: 'fastmail',
		name: 'Fastmail',
		servers: {imapHost: 'imap.fastmail.com', smtpHost: 'smtp.fastmail.com', smtpPort: 465},
	},
	{
		id: 'yahoo',
		name: 'Yahoo',
		servers: {imapHost: 'imap.mail.yahoo.com', smtpHost: 'smtp.mail.yahoo.com', smtpPort: 465},
	},
	{id: 'other', name: 'Other', servers: null},
];
