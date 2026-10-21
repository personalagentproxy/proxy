import type {Metadata} from 'next';
import {LegalLink, LegalList, LegalPage, LegalSection} from '@/components/legal-page';
import {LEGAL} from '@/lib/legal';

export const metadata: Metadata = {
	title: 'Privacy policy · Personal Agent Proxy',
	description:
		'How Personal Agent Proxy collects, uses, stores and shares information, including Google user data.',
};

const GOOGLE_USER_DATA_POLICY = 'https://developers.google.com/terms/api-services-user-data-policy';
const PLAID_END_USER_PRIVACY_POLICY = 'https://plaid.com/legal/#end-user-privacy-policy';

export default function PrivacyPage() {
	return (
		<LegalPage title="Privacy policy">
			<LegalSection title="About this policy">
				<p>
					This policy describes how {LEGAL.legalEntity} (&quot;Personal Agent Proxy&quot;,
					&quot;we&quot;, &quot;us&quot;) collects, uses, stores and discloses information when you
					use the hosted Personal Agent Proxy service at app.personalagentproxy.com, this website,
					the docs and any related services (together, the &quot;Services&quot;). By using the
					Services you agree to this policy. Personal Agent Proxy is open source, and a copy run by
					someone else on their own server is run by them, under their own policies, not this one.
				</p>
			</LegalSection>

			<LegalSection title="Changes to this policy">
				<p>
					We may change this policy from time to time. When we do, we post the new version here with
					a new effective date. For material changes, we make reasonable efforts to tell you, such
					as by email or a notice in the app. Your continued use of the Services after a change
					takes effect means you accept it.
				</p>
			</LegalSection>

			<LegalSection title="Information we collect">
				<p>
					<span className="text-foreground">Information you give us.</span> When you create an
					account, we collect your email address and, if you sign in with Google, your name, profile
					picture and Google account id. If you add a way to confirm it&apos;s you when you sign in,
					such as a passkey, an authenticator app or a phone number, we collect what it needs. We
					collect the information you type into the Services, such as the addresses, phone numbers
					and notes you and your agents keep in your vault, the services and accounts you connect,
					the agents you set up and the permissions you give them, the people you invite to an
					organization, such as their email addresses, and anything you send us when you contact us.
				</p>
				<p>
					<span className="text-foreground">Billing information.</span> If you pay for the Services,
					we collect billing information, such as your name, billing address, the plan you choose
					and your payment history. Card details are collected by our payment processor under its
					own privacy policy; we receive only limited details, such as the card&apos;s brand, last
					digits and expiry date.
				</p>
				<p>
					<span className="text-foreground">Information from your connected services.</span> When
					you connect a service, such as an email account, a calendar, an address book, a file or
					document store, a note-taking, meeting-notes or project-management tool, a bank, card or
					other financial account, a database or any other service that speaks MCP, we collect the
					credentials needed to reach it and, depending on the permissions you give your agents,
					information from that service, which may include: emails and other messages, with their
					attachments; calendars, events and invitations, with their guests and responses; contacts;
					files, folders, documents, spreadsheets, presentations and pages; notes, meeting notes and
					transcripts; issues, tasks, projects and comments; database tables, rows and query
					results; financial accounts, with their names, types, the last digits of their numbers,
					balances and limits, and their transactions, with amounts, dates, merchants, categories
					and locations; anything else a connected service returns to your agents; the metadata of
					all of these; and the results of the actions your agents take. Some of this may be
					sensitive, such as private communications, financial information or health information,
					depending on what you connect and what you let your agents do.
				</p>
				<p>
					<span className="text-foreground">Information about your agents&apos; activity.</span> We
					collect a record of what each agent requests through the Services and what it was allowed
					or denied, which may include the parameters of each request and the response returned, so
					you can see what your agents did and so the Services work.
				</p>
				<p>
					<span className="text-foreground">Information collected automatically.</span> When you or
					your agents use the Services, we may collect usage data such as the pages and features
					used, actions taken, the times of requests, IP address, browser and device information,
					and the agent or client software making a request. We collect some of this through cookies
					and similar technologies, described below.
				</p>
				<p>
					<span className="text-foreground">Information from other sources.</span> We may receive
					information about you from the companies that run the agents you authorize, from identity
					providers you sign in with, and from service providers that help us run the Services.
				</p>
				<p>
					<span className="text-foreground">Deidentified information.</span> We may deidentify or
					aggregate information so that it no longer identifies you, keep it in that form, and use
					it for any lawful purpose. We don&apos;t try to reidentify it, except to check that it
					stays deidentified.
				</p>
			</LegalSection>

			<LegalSection title="How we use information">
				<p>We use the information we collect to:</p>
				<LegalList>
					<li>
						provide, operate, maintain and secure the Services, including carrying out what your
						agents request within the permissions you set;
					</li>
					<li>show you what your agents did and let you manage them;</li>
					<li>personalize the Services, including for the agents you use;</li>
					<li>
						develop, improve and evaluate the Services and our technology, which may include
						training, fine-tuning and evaluating models, subject to the limits on Google user data
						below and to the choices described under &quot;Your choices&quot;;
					</li>
					<li>process payments and manage billing;</li>
					<li>
						communicate with you about the Services, respond to you, send you service and account
						notices, and send you news, updates and offers about the Services, which you can
						unsubscribe from;
					</li>
					<li>
						detect, investigate and prevent abuse, fraud and security incidents, and enforce our
						terms;
					</li>
					<li>comply with the law, and establish or defend legal claims.</li>
				</LegalList>
			</LegalSection>

			<LegalSection title="Information from Google Workspace">
				<p>
					When you connect a Google account, Google asks you to grant the Services access to parts
					of that account. Depending on what you grant, the Services may access your Google account
					email address and information in the Google services you grant access to, such as Gmail,
					Google Calendar, Google Drive, Google Docs, Google Sheets, Google Slides and Google
					Contacts, including the content and metadata of what is in them, and may act on it for
					your agents within the permissions you set, such as sending email, creating and changing
					documents and events, or moving items to Trash. Google&apos;s consent screen lets you
					decline any of these.
				</p>
				<p>
					We use information received from Google Workspace APIs only to provide and improve the
					user-facing features of the Services that you use: showing it to the agents you
					authorized, acting on it for them within the permissions you set, and keeping the records
					needed for those features to work. We store the credentials Google issues and, where a
					feature you use needs it, the information your agents request and the responses received,
					encrypted at rest, for as long as described under &quot;Retention and deletion&quot;.
				</p>
				<p>
					We disclose information from Google Workspace APIs only to the agents you authorized and
					the companies that run them, as needed to provide the feature you asked for; to the
					members of the organization you connected the account in, as described under &quot;How we
					disclose information&quot;; to service providers that help us run the Services and may
					handle it only for that purpose; and as required by law or to protect the security of the
					Services. We do not use it to serve advertising, do not sell it, do not disclose it to
					data brokers or information resellers, and do not use it to determine creditworthiness or
					for lending. We do not use information from Google Workspace APIs to develop, improve or
					train any artificial intelligence or machine learning model, other than a model
					personalized to you alone for a feature you use, and we do not allow third parties to do
					so. People working for us do not read it unless you ask us to and give your consent, it is
					needed for security or to investigate abuse, it is required by law, or it has been
					aggregated and deidentified for internal operations.
				</p>
				<p>
					Personal Agent Proxy&apos;s use and transfer to any other app of information received from
					Google APIs will adhere to the{' '}
					<LegalLink href={GOOGLE_USER_DATA_POLICY}>Google API Services User Data Policy</LegalLink>
					, including the Limited Use requirements.
				</p>
				<p>
					You can revoke the Services&apos; access to your Google account at any time by
					disconnecting it in the Services or at{' '}
					<LegalLink href="https://myaccount.google.com/permissions">
						myaccount.google.com/permissions
					</LegalLink>
					. Disconnecting deletes the stored credentials. Deleting your account deletes the
					information we collected from your Google account.
				</p>
			</LegalSection>

			<LegalSection title="Services connected through a third party">
				<p>
					Some services are connected through a third party that links the Services to your account
					there, such as Plaid Inc. for bank accounts. You sign in with your provider in that third
					party&apos;s own window and choose what to share, and the third party handles the
					information it collects under its own privacy policy, such as Plaid&apos;s{' '}
					<LegalLink href={PLAID_END_USER_PRIVACY_POLICY}>End User Privacy Policy</LegalLink>. We
					store the credentials it issues, encrypted at rest. Disconnecting the service in the
					Services, or deleting your account, ends our access through the third party where it
					offers a way, and you can also manage that access with the third party, such as at{' '}
					<LegalLink href="https://my.plaid.com">my.plaid.com</LegalLink>.
				</p>
			</LegalSection>

			<LegalSection title="Cookies and similar technologies">
				<p>
					We use cookies and similar technologies to keep you and your agents signed in, to carry
					sign-ins with third parties there and back, to remember your preferences, and to
					understand how the Services are used. You can control cookies through your browser, but
					some parts of the Services may not work without them. The Services don&apos;t currently
					respond to browser &quot;Do Not Track&quot; signals.
				</p>
			</LegalSection>

			<LegalSection title="How we disclose information">
				<p>We may disclose information:</p>
				<LegalList>
					<li>
						to the other members of an organization you use the Services in: depending on their
						role, they can see and manage its connections, agents, permissions, vault and activity,
						including what you added and what agents did with it;
					</li>
					<li>
						to the agents you authorize and the companies that run them, such as Anthropic, OpenAI
						or the maker of any other agent you connect, which handle it under their own terms and
						policies;
					</li>
					<li>to the services you connect, when your agents act on them for you;</li>
					<li>
						to service providers that help us run the Services, such as hosting, email and text
						message delivery, analytics, payment processing, security and AI model providers, which
						may use it only to provide services to us;
					</li>
					<li>
						to our affiliates, and to a buyer or successor in a merger, acquisition, financing or
						sale of assets, subject to this policy;
					</li>
					<li>
						to professional advisors, law enforcement, regulators and others when required by law,
						to enforce our terms, or to protect the rights, safety and security of anyone;
					</li>
					<li>with your direction or consent;</li>
					<li>in aggregated or deidentified form, with anyone.</li>
				</LegalList>
				<p>We don&apos;t sell personal information and don&apos;t disclose it to data brokers.</p>
			</LegalSection>

			<LegalSection title="Retention and deletion">
				<p>
					We keep information for as long as needed for the purposes described in this policy,
					including for as long as your account exists, and as needed to comply with the law,
					resolve disputes and enforce our agreements. Disconnecting a service deletes its
					credentials but doesn&apos;t by itself delete the other information we collected from it.
					You can delete your account, and the information in it, at any time in the Services&apos;
					settings, or by writing to {LEGAL.contactEmail}. Deleting it also deletes any organization
					only you belong to, disconnecting its connected services and revoking our access with each
					service where it offers a way. What you added to an organization others belong to stays
					with that organization until its members delete it. We may keep billing records as the law
					requires, deidentified information, and copies in backups for a limited time.
				</p>
			</LegalSection>

			<LegalSection title="Your choices">
				<LegalList>
					<li>
						You can see and change your connections, your agents and their permissions, and the
						record of their activity, in the Services at any time.
					</li>
					<li>
						You can ask us not to use information from your account to train or improve our models,
						by writing to {LEGAL.contactEmail} or through the settings when they offer it. This
						applies going forward and doesn&apos;t affect models already trained. We never use
						information from Google Workspace APIs this way, whatever you choose.
					</li>
					<li>
						You can unsubscribe from news, updates and offers with the link in each email. Service
						and account notices, such as security alerts and billing receipts, still reach you while
						you have an account.
					</li>
					<li>
						You can ask for a copy of your information, or to have it corrected or deleted, by
						writing to {LEGAL.contactEmail}.
					</li>
					<li>
						You can revoke a connected service&apos;s access at any time, in the Services or with
						that service.
					</li>
				</LegalList>
			</LegalSection>

			<LegalSection title="Children">
				<p>
					The Services aren&apos;t intended for anyone under 18, and we don&apos;t knowingly collect
					information from children. If you believe a child has given us information, write to{' '}
					{LEGAL.contactEmail} and we will delete it.
				</p>
			</LegalSection>

			<LegalSection title="Security">
				<p>
					We use technical and organizational measures intended to protect information, including
					encrypting credentials and stored content at rest and encrypting data in transit. No
					method of transmission or storage is completely secure, and we can&apos;t guarantee
					security. Agents can act on your accounts within the permissions you set, including in
					ways you didn&apos;t intend or that can&apos;t be undone, so review what you allow and
					what your agents do.
				</p>
			</LegalSection>

			<LegalSection title="Where information is processed">
				<p>
					The Services are run from the United States, and information may be processed there and
					anywhere our service providers operate. If you use the Services from elsewhere, your
					information is transferred to those places.
				</p>
			</LegalSection>

			<LegalSection title="Open source and self-hosting">
				<p>
					The code of the Services is public at{' '}
					<LegalLink href="https://github.com/personalagentproxy/proxy">
						github.com/personalagentproxy/proxy
					</LegalLink>
					. Whoever runs a self-hosted copy controls the information in it. A self-hosted copy may
					send us anonymous telemetry about the installation unless its host turns it off, as the{' '}
					<LegalLink href="https://docs.personalagentproxy.com/self-hosting/telemetry/">
						docs
					</LegalLink>{' '}
					describe.
				</p>
			</LegalSection>

			<LegalSection title="Contact">
				<p>Questions about this policy or your information go to {LEGAL.contactEmail}.</p>
			</LegalSection>
		</LegalPage>
	);
}
