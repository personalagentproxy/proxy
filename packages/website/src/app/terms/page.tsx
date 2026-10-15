import type {Metadata} from 'next';
import {LegalLink, LegalList, LegalPage, LegalSection} from '@/components/legal-page';
import {LEGAL} from '@/lib/legal';

export const metadata: Metadata = {
	title: 'Terms of service · Personal Agent Proxy',
	description: 'The terms for using the hosted Personal Agent Proxy.',
};

export default function TermsPage() {
	return (
		<LegalPage title="Terms of service">
			<LegalSection title="Agreement">
				<p>
					These terms are an agreement between you and {LEGAL.legalEntity} (&quot;Personal Agent
					Proxy&quot;, &quot;we&quot;, &quot;us&quot;) covering your use of the hosted Personal
					Agent Proxy service at app.personalagentproxy.com, this website, the docs and any related
					services (the &quot;Services&quot;). By using the Services you agree to these terms and to
					our <LegalLink href="/privacy/">privacy policy</LegalLink>. If you don&apos;t agree,
					don&apos;t use the Services. The code is open source under the MIT License; a copy you run
					yourself is governed by that license, not by these terms.
				</p>
			</LegalSection>

			<LegalSection title="Who may use the Services">
				<p>
					You must be at least 18 years old to use the Services. If you use them for an
					organization, you confirm you have authority to bind it, and &quot;you&quot; includes it.
					We may refuse, limit or close accounts at our discretion.
				</p>
			</LegalSection>

			<LegalSection title="Your account">
				<p>
					You are responsible for your account, for keeping your sign-in and your agents&apos;
					logins secure, and for everything done through them. Tell us promptly at{' '}
					{LEGAL.contactEmail} if you believe your account or an agent login has been compromised.
				</p>
			</LegalSection>

			<LegalSection title="Agents and actions">
				<p>
					The Services let AI agents you choose (&quot;Agents&quot;) use the accounts and
					information you connect, within permissions you set, and take actions on your behalf, such
					as reading, creating, changing, sending and moving to Trash emails, files, records and
					other items in the services you connect (&quot;Actions&quot;). By giving an Agent access,
					you authorize the Services to carry out the Actions that Agent requests, within the
					permissions you set, as if you had taken them yourself, and you agree to be bound by their
					results, including any agreements, messages or transactions an Action enters into with
					third parties.
				</p>
				<p>
					Agents are run by their own companies, under their own terms, and may act in ways you
					didn&apos;t intend. Actions may be wrong, incomplete or impossible to undo. You are
					responsible for choosing which Agents to authorize, for the permissions you give them, for
					monitoring what they do, and for verifying their results before relying on them. We are
					not a party to anything an Agent does with the access you gave it, and we are not
					responsible for any Action, its consequences, or for the conduct of any Agent or the
					company running it.
				</p>
			</LegalSection>

			<LegalSection title="Connected services">
				<p>
					When you connect a third-party service, you authorize the Services to access, retrieve,
					store, index and act on information in it on your behalf and on behalf of your Agents, as
					described in the privacy policy. You confirm you have the right to connect it and to grant
					that access, and you are responsible for complying with that service&apos;s terms. We
					don&apos;t control third-party services, and they may change, limit or end the access they
					offer at any time, which may affect the Services.
				</p>
			</LegalSection>

			<LegalSection title="Your content and our rights">
				<p>
					You keep ownership of the information you provide, connect or generate through the
					Services (&quot;Your Content&quot;). You grant us a worldwide, non-exclusive, royalty-free
					license to host, store, copy, process, transmit, display and otherwise use Your Content as
					needed to provide, maintain, secure, develop and improve the Services and our technology,
					including to train, fine-tune and evaluate models, subject to the privacy policy and the
					choices it describes. Information received from Google Workspace APIs is used only as the
					privacy policy&apos;s Google section allows, and is never used to train models other than
					one personalized to you. You confirm you have the rights needed to grant this license.
				</p>
				<p>
					We own the Services and everything in them other than Your Content, including our
					software, designs and brand, and we grant you a limited, personal, non-exclusive,
					non-transferable right to use the Services under these terms. Any feedback you give us may
					be used freely by us without obligation to you. We may use usage data in aggregated or
					deidentified form for any purpose.
				</p>
			</LegalSection>

			<LegalSection title="Acceptable use">
				<p>You agree not to, and not to let your Agents:</p>
				<LegalList>
					<li>
						break the law, infringe anyone&apos;s rights, or use the Services to harass, defraud,
						spam or harm anyone;
					</li>
					<li>
						connect or access an account, service or data you don&apos;t have the right to use, or
						use a connected service against its terms;
					</li>
					<li>
						probe, scan, attack, overload or interfere with the Services, bypass their security or
						limits, or access them other than through the interfaces we provide;
					</li>
					<li>
						reverse engineer the hosted Services except as the open-source license allows, or use
						the Services to build a competing product;
					</li>
					<li>
						upload malware, or use the Services to generate or distribute harmful, deceptive or
						unlawful content.
					</li>
				</LegalList>
			</LegalSection>

			<LegalSection title="Fees">
				<p>
					The Services are currently offered without charge. We may introduce fees or paid plans
					with notice, and your continued use after they take effect means you accept them. Fees are
					non-refundable except as the law requires.
				</p>
			</LegalSection>

			<LegalSection title="Disclaimers">
				<p>
					THE SERVICES, AND EVERYTHING PROVIDED THROUGH THEM, INCLUDING THE RESULTS OF ACTIONS, ARE
					PROVIDED &quot;AS IS&quot; AND &quot;AS AVAILABLE&quot;, WITHOUT WARRANTIES OF ANY KIND,
					EXPRESS OR IMPLIED, INCLUDING WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR
					PURPOSE, TITLE AND NON-INFRINGEMENT. WE DON&apos;T WARRANT THAT THE SERVICES WILL BE
					UNINTERRUPTED, ERROR-FREE OR SECURE, THAT ANY AGENT OR CONNECTED SERVICE WILL KEEP WORKING
					WITH THEM, OR THAT ANY RESULT WILL BE ACCURATE OR RELIABLE. NOTHING PROVIDED THROUGH THE
					SERVICES IS PROFESSIONAL ADVICE.
				</p>
			</LegalSection>

			<LegalSection title="Limitation of liability">
				<p>
					TO THE FULLEST EXTENT THE LAW ALLOWS, WE AND OUR AFFILIATES, OFFICERS, EMPLOYEES AND
					SUPPLIERS WILL NOT BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL,
					EXEMPLARY OR PUNITIVE DAMAGES, OR FOR ANY LOSS OF DATA, PROFITS, REVENUE OR GOODWILL,
					ARISING FROM OR RELATING TO THE SERVICES, ANY AGENT OR ANY ACTION, HOWEVER CAUSED AND
					UNDER ANY THEORY OF LIABILITY, EVEN IF ADVISED OF THE POSSIBILITY. OUR TOTAL LIABILITY FOR
					ALL CLAIMS RELATING TO THE SERVICES IS LIMITED TO THE GREATER OF ONE HUNDRED US DOLLARS
					($100) AND THE AMOUNT YOU PAID US FOR THE SERVICES IN THE TWELVE MONTHS BEFORE THE CLAIM.
					WHERE THE LAW DOESN&apos;T ALLOW A LIMIT, OUR LIABILITY IS LIMITED TO THE SMALLEST AMOUNT
					IT ALLOWS.
				</p>
			</LegalSection>

			<LegalSection title="Indemnification">
				<p>
					You will defend, indemnify and hold us and our affiliates, officers, employees and
					suppliers harmless from any claims, damages, losses and expenses, including reasonable
					legal fees, arising from your use of the Services, Your Content, the Agents you authorize
					and their Actions, your breach of these terms, or your violation of the law or
					anyone&apos;s rights.
				</p>
			</LegalSection>

			<LegalSection title="Termination">
				<p>
					You can stop using the Services at any time and delete your account in the Services&apos;
					settings, or ask us to by writing to {LEGAL.contactEmail}. We may suspend or end your
					access to the Services, or any part of them, at any time, with or without notice, for any
					or no reason, including if we believe you broke these terms. On termination your right to
					use the Services ends; we may, but need not, delete Your Content, and the sections that by
					their nature should survive do so.
				</p>
			</LegalSection>

			<LegalSection title="Governing law">
				<p>
					These terms are governed by the laws of {LEGAL.jurisdiction}, without regard to its
					conflict-of-law rules.
				</p>
			</LegalSection>

			<LegalSection title="Arbitration and class action waiver">
				<p>
					<span className="text-foreground">
						Please read this section carefully. It affects your rights, including your right to go
						to court and to take part in a class action.
					</span>
				</p>
				<p>
					<span className="text-foreground">Talk to us first.</span> Before starting a formal
					dispute, you agree to write to {LEGAL.contactEmail} describing it, and we agree to do the
					same to you, and to try for 30 days to resolve it informally.
				</p>
				<p>
					<span className="text-foreground">Individual arbitration.</span> Any dispute, claim or
					controversy between you and us relating to the Services or these terms that isn&apos;t
					resolved informally will be settled by binding arbitration before a single arbitrator,
					administered by JAMS under its rules in force when the arbitration starts, and governed by
					the Federal Arbitration Act. The arbitrator decides everything, including whether this
					section applies, and can award whatever a court could, to you alone. Arbitration takes
					place in {LEGAL.jurisdiction}, or by video or phone if you prefer, and its outcome can be
					entered as a judgment in any court. Each side pays its own costs, and JAMS&apos;s rules
					say who pays its fees.
				</p>
				<p>
					<span className="text-foreground">No class actions.</span> You and we each agree to bring
					claims only as an individual, not as a plaintiff or class member in any class,
					consolidated or representative action, and the arbitrator may not combine claims of more
					than one person or award relief to anyone but the parties. If this paragraph is found
					unenforceable for a claim, that claim goes to court, and the rest of this section still
					applies to the others.
				</p>
				<p>
					<span className="text-foreground">What stays out of arbitration.</span> Either of us may
					bring an individual claim in small claims court, seek an injunction or other equitable
					relief, or bring a claim about the infringement or misuse of intellectual property, in
					court instead.
				</p>
				<p>
					<span className="text-foreground">Opting out.</span> You can reject this arbitration
					agreement by writing to {LEGAL.contactEmail} within 30 days of first creating your account
					or first agreeing to these terms, with your account email and a statement that you opt out
					of arbitration. Opting out doesn&apos;t affect the class action waiver, which still
					applies.
				</p>
				<p>
					<span className="text-foreground">Courts.</span> Where a dispute isn&apos;t arbitrated, it
					will be brought in the state or federal courts in {LEGAL.jurisdiction}, and you consent to
					their jurisdiction. If the law where you live doesn&apos;t allow mandatory arbitration or
					gives you the right to bring a dispute in your own courts, this section applies only as
					far as that law allows.
				</p>
			</LegalSection>

			<LegalSection title="General">
				<p>
					These terms, with the privacy policy, are the whole agreement between you and us about the
					Services. If part of them is unenforceable, the rest stays in effect. You may not assign
					them; we may. Our not enforcing a term isn&apos;t a waiver of it.
				</p>
			</LegalSection>

			<LegalSection title="Changes and contact">
				<p>
					We may change these terms from time to time. When we do, we post the new version here with
					a new effective date, and for material changes we make reasonable efforts to tell you.
					Your continued use of the Services after a change takes effect means you accept it.
					Questions go to {LEGAL.contactEmail}.
				</p>
			</LegalSection>
		</LegalPage>
	);
}
