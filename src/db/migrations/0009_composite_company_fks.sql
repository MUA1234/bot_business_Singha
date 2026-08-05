-- 0009_composite_company_fks.sql
-- Architecture V2 change plan §5.5 — a child row must never belong to a different
-- company than its parent. Enforced with composite (id, company_id) references.
-- Forward-only, idempotent, and DEFENSIVE: each step is guarded with to_regclass so
-- it is skipped when a table is absent. FKs are added NOT VALID so applying this can
-- never fail on pre-existing rows; validate later with:
--   ALTER TABLE <child> VALIDATE CONSTRAINT <name>;

-- Parents need a UNIQUE(id, company_id) target for the composite FK.
do $$
begin
  if to_regclass('public.quotations') is not null
     and not exists (select 1 from pg_constraint where conname = 'quotations_id_company_uq') then
    alter table quotations add constraint quotations_id_company_uq unique (id, company_id);
  end if;
  if to_regclass('public.orders') is not null
     and not exists (select 1 from pg_constraint where conname = 'orders_id_company_uq') then
    alter table orders add constraint orders_id_company_uq unique (id, company_id);
  end if;
  if to_regclass('public.wa_conversations') is not null
     and not exists (select 1 from pg_constraint where conname = 'wa_conversations_id_company_uq') then
    alter table wa_conversations add constraint wa_conversations_id_company_uq unique (id, company_id);
  end if;
end $$;

-- Child composite FKs (NOT VALID: enforced for new/updated rows immediately).
do $$
begin
  if to_regclass('public.quotation_items') is not null
     and not exists (select 1 from pg_constraint where conname = 'quotation_items_company_match_fk') then
    alter table quotation_items add constraint quotation_items_company_match_fk
      foreign key (quotation_id, company_id) references quotations (id, company_id) not valid;
  end if;

  if to_regclass('public.price_confirmations') is not null
     and not exists (select 1 from pg_constraint where conname = 'price_conf_company_match_fk') then
    alter table price_confirmations add constraint price_conf_company_match_fk
      foreign key (quotation_id, company_id) references quotations (id, company_id) not valid;
  end if;

  if to_regclass('public.wa_messages') is not null
     and not exists (select 1 from pg_constraint where conname = 'wa_messages_company_match_fk') then
    alter table wa_messages add constraint wa_messages_company_match_fk
      foreign key (conversation_id, company_id) references wa_conversations (id, company_id) not valid;
  end if;

  if to_regclass('public.quotations') is not null
     and not exists (select 1 from pg_constraint where conname = 'quotations_order_company_match_fk') then
    alter table quotations add constraint quotations_order_company_match_fk
      foreign key (order_id, company_id) references orders (id, company_id) not valid;
  end if;
end $$;
