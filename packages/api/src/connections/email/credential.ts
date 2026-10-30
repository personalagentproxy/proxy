import type {MailServers} from '@proxy/utils/email-providers';

/** What an email connection stores, encrypted: the mailbox's servers and its app password. */
export type EmailCredential = MailServers & {username: string; password: string};
