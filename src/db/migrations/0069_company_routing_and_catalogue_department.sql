-- 0069 — de-hardcode company resolution, department routing and currency.
--
-- Three constants were compiled into the application and are replaced by data:
--
--   1. `DEFAULT_COMPANY_ID` (src/lib/constants.ts) — EVERY inbound WhatsApp message was
--      attributed to one hardcoded company UUID, so a second company could never be
--      onboarded and, worse, its traffic would have been written into the first company's
--      records. Cross-company leakage is a critical failure (CLAUDE.md core principles).
--      `companies.whatsapp_phone_number_id` maps the Meta business number that RECEIVED a
--      message to its company, so the company is derived from the event, never assumed.
--
--   2. `routeDepartment ?? "sales"` (src/lib/quotations.ts) — every price confirmation was
--      routed to Sales regardless of what was ordered. Routing is now data-driven:
--      the matched catalogue product's `department`, else the company's configured
--      `default_price_confirmation_department`, else 'sales' (unchanged behaviour when
--      neither is set, so this migration alone changes nothing).
--
--   3. `"LKR"` literals — `companies.base_currency` already existed and was unused by the
--      quotation path. No schema change needed; the application now reads it.
--
-- Additive and idempotent: nullable columns + optional FKs only. No data is rewritten and
-- no existing row changes meaning. Safe to apply while the system is live.

-- 1. Company ←→ WhatsApp business number (the inbound routing key).
alter table companies add column if not exists whatsapp_phone_number_id text;

-- One Meta phone number belongs to exactly one company; a duplicate would reintroduce the
-- ambiguity this migration exists to remove. Partial so the many NULLs stay legal.
create unique index if not exists companies_whatsapp_phone_number_id_key
  on companies (whatsapp_phone_number_id)
  where whatsapp_phone_number_id is not null;

-- 2. Company-level fallback for price-confirmation routing.
alter table companies add column if not exists default_price_confirmation_department text;

-- 3. Per-product routing. A quotation item priced from a catalogue entry inherits that
--    entry's department, so roofing sheets can reach Procurement while a service reaches Sales.
alter table product_catalog add column if not exists department text;

-- Both department columns must name a REAL department, or routing would silently address a
-- queue nobody reads. `departments_catalog.key` is the catalogue the dashboards render from.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'companies_default_price_conf_dept_fk'
  ) then
    alter table companies
      add constraint companies_default_price_conf_dept_fk
      foreign key (default_price_confirmation_department)
      references departments_catalog (key)
      on update cascade on delete set null;
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'product_catalog_department_fk'
  ) then
    alter table product_catalog
      add constraint product_catalog_department_fk
      foreign key (department)
      references departments_catalog (key)
      on update cascade on delete set null;
  end if;
end $$;

comment on column companies.whatsapp_phone_number_id is
  'Meta WhatsApp Cloud API phone_number_id that receives this company''s inbound messages. '
  'The webhook resolves the company from this; there is no default company.';
comment on column companies.default_price_confirmation_department is
  'Department that receives price confirmations when the catalogue entry does not name one.';
comment on column product_catalog.department is
  'Department that prices this product when a quotation item matches it.';
