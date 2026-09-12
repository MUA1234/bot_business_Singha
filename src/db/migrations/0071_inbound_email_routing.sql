-- 0071_inbound_email_routing.sql
--
-- Company routing key for the EMAIL ingestion channel, mirroring exactly what 0069 did for
-- WhatsApp. `/api/webhooks/email` was a documented 501 stub whose TODO read "verify provider
-- signature, then ingest"; the ingestion engine (`ingestSourceEvent`) and the `email` source
-- channel have existed and been tested since 0004. The one thing the route could not do was
-- answer WHICH COMPANY an inbound email belongs to — and guessing is precisely the
-- cross-company leakage CLAUDE.md calls a critical failure, so the route stayed closed.
--
-- The routing key is the address the mail was delivered TO, the exact analogue of
-- `companies.whatsapp_phone_number_id` (the Meta number that RECEIVED the message). The
-- company is therefore derived from the event, never assumed, and an unmapped address fails
-- closed as `company_unresolved` rather than landing in some default company's records.
--
-- ADDITIVE AND IDEMPOTENT: one nullable column + one partial unique index. No data is
-- rewritten, no existing row changes meaning, and nothing behaves differently until an
-- address is actually configured. Safe to apply while the system is live.

alter table companies add column if not exists inbound_email_address text;

-- Stored folded to lower case so routing is case-insensitive (RFC 5321 leaves the local part
-- case-sensitive in theory; no real provider relies on that, and treating Sales@ and sales@
-- as different companies would be a routing trap, not a feature). The application lower-cases
-- the recipient before lookup; this keeps the stored side honest.
alter table companies drop constraint if exists companies_inbound_email_address_lower;
alter table companies add constraint companies_inbound_email_address_lower
  check (inbound_email_address is null or inbound_email_address = lower(inbound_email_address));

-- One inbound address belongs to exactly one company. A duplicate would reintroduce the very
-- ambiguity this column exists to remove. Partial, so the many NULLs stay legal.
create unique index if not exists companies_inbound_email_address_key
  on companies (inbound_email_address)
  where inbound_email_address is not null;

comment on column companies.inbound_email_address is
  'Address inbound mail is delivered to for this company; the routing key for /api/webhooks/email. NULL = email ingestion not configured for this company (the webhook then fails closed).';
