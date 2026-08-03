import type { Metadata } from "next";
import { LegalShell, H2 } from "../_components/LegalShell";
import { LEGAL } from "../legal-config";

export const metadata: Metadata = {
  title: `Data Deletion — ${LEGAL.appName}`,
  description: `How to request deletion of your data from ${LEGAL.appName}.`,
};

export default function DataDeletion() {
  return (
    <LegalShell title="Data Deletion Request">
      <p>
        This page explains how to request deletion of your personal data held by{" "}
        {LEGAL.legalEntity} in connection with {LEGAL.appName} (the &ldquo;Service&rdquo;),
        which receives messages through the WhatsApp Business Platform.
      </p>

      <H2>How to request deletion</H2>
      <p>You can request deletion in either of these ways:</p>
      <ul>
        <li>
          <strong>Email:</strong> send a message to{" "}
          <a href={`mailto:${LEGAL.contactEmail}?subject=Data%20Deletion%20Request`}>
            {LEGAL.contactEmail}
          </a>{" "}
          with the subject &ldquo;Data Deletion Request&rdquo;, from the email associated
          with your account if you have one.
        </li>
        <li>
          <strong>WhatsApp:</strong> send the word <strong>DELETE</strong> to our WhatsApp
          number {LEGAL.whatsappNumber}, from the number you wish to have removed.
        </li>
      </ul>
      <p>
        To help us locate your data, please include the WhatsApp phone number and/or email
        address you used, and a brief description of the data you want removed. We may need
        to verify your identity before acting on a request.
      </p>

      <H2>What we delete</H2>
      <p>
        On a verified request, we will delete or anonymise the personal data we hold about
        you, including your WhatsApp phone number, display name, and the message content
        and documents you submitted, except where we are required or permitted by law to
        retain them (see below).
      </p>

      <H2>Records we may retain</H2>
      <p>
        Because the Service maintains accounting and financial records, certain
        information must be kept for a statutory retention period to comply with
        accounting, tax, audit, and other legal obligations, even after a deletion
        request. Where this applies, we restrict processing of that data to what the law
        requires and delete it once the retention period ends. We also retain minimal,
        anonymised audit records needed to demonstrate that a deletion request was
        actioned.
      </p>

      <H2>Timing</H2>
      <p>
        We aim to acknowledge requests within a few business days and to complete verified
        deletions within 30 days, or sooner where required by applicable law. If a request
        is delayed or cannot be fully met (for example, due to a legal retention
        requirement), we will explain why.
      </p>

      <H2>Contact</H2>
      <p>
        Questions about deletion or your privacy rights? Contact {LEGAL.legalEntity} at{" "}
        <a href={`mailto:${LEGAL.contactEmail}`}>{LEGAL.contactEmail}</a>. See also our{" "}
        <a href="/privacy">Privacy Policy</a>.
      </p>
    </LegalShell>
  );
}
