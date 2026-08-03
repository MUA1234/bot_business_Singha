import type { Metadata } from "next";
import { LegalShell, H2 } from "../_components/LegalShell";
import { LEGAL } from "../legal-config";

export const metadata: Metadata = {
  title: `Privacy Policy — ${LEGAL.appName}`,
  description: `How ${LEGAL.legalEntity} collects, uses, and protects data in ${LEGAL.appName}.`,
};

export default function PrivacyPolicy() {
  return (
    <LegalShell title="Privacy Policy">
      <p>
        This Privacy Policy explains how {LEGAL.legalEntity} (&ldquo;we&rdquo;,
        &ldquo;us&rdquo;, &ldquo;our&rdquo;) collects, uses, shares, and protects
        information in connection with {LEGAL.appName} (the &ldquo;Service&rdquo;), an
        internal, event-driven business and finance management system that receives
        messages through the WhatsApp Business Platform and processes business records.
        We handle personal data in accordance with {LEGAL.dataProtectionLaw} and other
        applicable laws.
      </p>

      <H2>1. Who this policy is for</H2>
      <p>
        The Service is an internal operational tool used by authorised staff and
        representatives of {LEGAL.legalEntity} and its associated companies. It is not a
        consumer product. If you interact with our WhatsApp number, or your information
        appears in a business record we process (for example, as a supplier, customer, or
        employee), this policy describes how that information is handled.
      </p>

      <H2>2. Information we collect</H2>
      <ul>
        <li>
          <strong>WhatsApp messages and metadata:</strong> the content of messages you
          send to our WhatsApp number, your WhatsApp display name and phone number, and
          message timestamps and delivery status, received via the official Meta WhatsApp
          Cloud API.
        </li>
        <li>
          <strong>Business and financial records:</strong> information contained in
          messages, receipts, invoices, and documents you submit &mdash; such as amounts,
          dates, counterparties, payment methods, and purposes of transactions.
        </li>
        <li>
          <strong>Account information:</strong> for staff users, name, email, role, and
          company access assigned to your account.
        </li>
        <li>
          <strong>Technical and audit logs:</strong> processing events, identifiers, and
          audit records we keep to operate the Service securely and accurately.
        </li>
      </ul>

      <H2>3. How we use information</H2>
      <ul>
        <li>To receive, understand, and record business and financial events.</li>
        <li>
          To ask clarifying questions, request supporting evidence, detect possible
          duplicates, and route items for human review and approval.
        </li>
        <li>To maintain accounting records, approvals, and an audit trail.</li>
        <li>To operate, secure, debug, and improve the Service.</li>
        <li>To comply with legal, accounting, tax, and regulatory obligations.</li>
      </ul>
      <p>
        We do not use your information for advertising, and we do not sell personal data.
      </p>

      <H2>4. Automated processing and AI</H2>
      <p>
        The Service uses a third-party large-language-model provider (OpenAI) to read the
        content of submitted messages and documents and extract structured information
        (for example, the amount and purpose of an expense). This data is sent to the
        provider solely to perform that extraction. We do not permit the provider to use
        your data to train its models. Automated outputs are advisory only: material
        actions require validation against deterministic rules and, where relevant, human
        approval. No bank payment or transfer is ever executed automatically by the
        Service.
      </p>

      <H2>5. WhatsApp and Meta</H2>
      <p>
        We use the official Meta WhatsApp Business Platform to send and receive messages.
        Your use of WhatsApp is also governed by Meta&rsquo;s own terms and privacy
        policy. Messages are processed within the platform&rsquo;s customer-service
        window rules. We only message you in connection with the business purposes above.
      </p>

      <H2>6. Sharing and service providers</H2>
      <p>We share information only with providers that help us run the Service, under appropriate safeguards:</p>
      <ul>
        <li>Meta Platforms (WhatsApp Business Platform &mdash; message delivery).</li>
        <li>Supabase (database, authentication, and file storage).</li>
        <li>Vercel (application hosting).</li>
        <li>OpenAI (AI extraction, as described in section 4).</li>
        <li>Inngest (durable background job processing).</li>
      </ul>
      <p>
        We may also disclose information where required by law, to protect our rights, or
        as part of a corporate transaction, subject to applicable law.
      </p>

      <H2>7. Data retention</H2>
      <p>
        We retain business and financial records, and their associated audit trail, for
        as long as necessary for the purposes above and to meet legal, accounting, and
        tax record-keeping obligations, after which they are deleted or anonymised. Some
        records must be retained for a statutory period even after a deletion request
        (see our <a href="/data-deletion">Data Deletion</a> page).
      </p>

      <H2>8. Security</H2>
      <p>
        We apply technical and organisational measures including access controls,
        company-level data isolation, encryption in transit, least-privilege
        credentials, and append-only audit logging. No system is perfectly secure, but we
        work to protect your information and to limit access to authorised personnel.
      </p>

      <H2>9. Your rights</H2>
      <p>
        Subject to applicable law, you may request access to, correction of, or deletion
        of your personal data, and you may object to or restrict certain processing. To
        exercise these rights, see the <a href="/data-deletion">Data Deletion</a> page or
        contact us at{" "}
        <a href={`mailto:${LEGAL.contactEmail}`}>{LEGAL.contactEmail}</a>. You may also
        have the right to lodge a complaint with the relevant data protection authority in{" "}
        {LEGAL.jurisdiction}.
      </p>

      <H2>10. International transfers</H2>
      <p>
        Some of our providers process data outside {LEGAL.jurisdiction}. Where personal
        data is transferred internationally, we take steps to ensure an appropriate level
        of protection consistent with applicable law.
      </p>

      <H2>11. Children</H2>
      <p>
        The Service is not directed to children and is not intended for use by anyone
        under 18. We do not knowingly collect data from children.
      </p>

      <H2>12. Changes to this policy</H2>
      <p>
        We may update this policy from time to time. Material changes will be reflected by
        updating the &ldquo;Last updated&rdquo; date at the top of this page.
      </p>

      <H2>13. Contact us</H2>
      <p>
        {LEGAL.legalEntity} &mdash;{" "}
        <a href={`mailto:${LEGAL.contactEmail}`}>{LEGAL.contactEmail}</a>. WhatsApp:{" "}
        {LEGAL.whatsappNumber}.
      </p>
    </LegalShell>
  );
}
