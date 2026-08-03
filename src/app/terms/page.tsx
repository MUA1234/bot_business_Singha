import type { Metadata } from "next";
import { LegalShell, H2 } from "../_components/LegalShell";
import { LEGAL } from "../legal-config";

export const metadata: Metadata = {
  title: `Terms of Service — ${LEGAL.appName}`,
  description: `The terms governing use of ${LEGAL.appName} by ${LEGAL.legalEntity}.`,
};

export default function TermsOfService() {
  return (
    <LegalShell title="Terms of Service">
      <p>
        These Terms of Service (&ldquo;Terms&rdquo;) govern access to and use of{" "}
        {LEGAL.appName} (the &ldquo;Service&rdquo;), provided by {LEGAL.legalEntity}{" "}
        (&ldquo;we&rdquo;, &ldquo;us&rdquo;, &ldquo;our&rdquo;). By accessing or using the
        Service, or by messaging our WhatsApp number, you agree to these Terms. If you do
        not agree, do not use the Service.
      </p>

      <H2>1. The Service</H2>
      <p>
        The Service is an internal, event-driven business and finance management system.
        It receives messages via the WhatsApp Business Platform, extracts and records
        business and financial events, applies approval rules, and maintains accounting
        records and an audit trail for {LEGAL.legalEntity} and its associated companies.
      </p>

      <H2>2. Eligibility and accounts</H2>
      <p>
        The Service is intended for authorised staff and representatives. You are
        responsible for maintaining the confidentiality of your account and for all
        activity under it. You must provide accurate information and promptly update it as
        needed.
      </p>

      <H2>3. Acceptable use</H2>
      <p>You agree not to:</p>
      <ul>
        <li>Use the Service for any unlawful, fraudulent, or unauthorised purpose.</li>
        <li>Submit content you are not entitled to submit, or that infringes others&rsquo; rights.</li>
        <li>Attempt to bypass authentication, permissions, company isolation, or approval controls.</li>
        <li>Interfere with, disrupt, or attempt to gain unauthorised access to the Service or its infrastructure.</li>
        <li>Attempt to cause automated systems to take actions that require human authority.</li>
      </ul>

      <H2>4. WhatsApp messaging</H2>
      <p>
        Communications are delivered through the official Meta WhatsApp Business Platform
        and are also subject to Meta&rsquo;s terms and policies. By messaging our number,
        you consent to receive related messages from us in connection with the business
        purposes of the Service. Standard carrier or data charges may apply.
      </p>

      <H2>5. Financial information &mdash; important notice</H2>
      <p>
        The Service assists with recording and organising business and financial
        information. It is <strong>not</strong> a substitute for professional accounting,
        tax, legal, or financial advice. Records created by the Service may begin as
        drafts and require review and approval before they are relied upon. The Service
        does <strong>not</strong> execute bank payments or transfers, and does not
        autonomously post material accounting entries. You are responsible for verifying
        the accuracy and appropriateness of all records and for your own compliance
        obligations.
      </p>

      <H2>6. Automated and AI-generated output</H2>
      <p>
        The Service uses automated processing, including artificial intelligence, to
        interpret messages and documents. AI output may be incomplete or inaccurate and
        is provided on an advisory basis only. You should not rely on AI output without
        human review. We are not liable for decisions made in reliance on automated output
        without appropriate verification.
      </p>

      <H2>7. Intellectual property</H2>
      <p>
        The Service, including its software and content (excluding data you submit),
        belongs to {LEGAL.legalEntity} or its licensors. You retain rights in the data you
        submit and grant us the rights necessary to process it to provide the Service.
      </p>

      <H2>8. Availability and disclaimer of warranties</H2>
      <p>
        The Service is provided &ldquo;as is&rdquo; and &ldquo;as available&rdquo;,
        without warranties of any kind, whether express or implied, including
        merchantability, fitness for a particular purpose, and non-infringement. We do not
        warrant that the Service will be uninterrupted, error-free, or secure.
      </p>

      <H2>9. Limitation of liability</H2>
      <p>
        To the maximum extent permitted by law, {LEGAL.legalEntity} will not be liable for
        any indirect, incidental, special, consequential, or punitive damages, or for any
        loss of profits, revenue, data, or goodwill, arising out of or in connection with
        your use of the Service.
      </p>

      <H2>10. Indemnity</H2>
      <p>
        You agree to indemnify and hold harmless {LEGAL.legalEntity} from claims, losses,
        and expenses arising from your misuse of the Service or breach of these Terms.
      </p>

      <H2>11. Suspension and termination</H2>
      <p>
        We may suspend or terminate access to the Service at any time, including for breach
        of these Terms or to protect the Service or its users.
      </p>

      <H2>12. Governing law</H2>
      <p>
        These Terms are governed by the laws of {LEGAL.jurisdiction}, and the courts of{" "}
        {LEGAL.jurisdiction} have exclusive jurisdiction over any dispute, without regard
        to conflict-of-law principles.
      </p>

      <H2>13. Changes to these Terms</H2>
      <p>
        We may update these Terms from time to time. Continued use of the Service after
        changes take effect constitutes acceptance of the updated Terms.
      </p>

      <H2>14. Contact</H2>
      <p>
        {LEGAL.legalEntity} &mdash;{" "}
        <a href={`mailto:${LEGAL.contactEmail}`}>{LEGAL.contactEmail}</a>. WhatsApp:{" "}
        {LEGAL.whatsappNumber}.
      </p>
    </LegalShell>
  );
}
