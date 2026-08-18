-- Realistic hosted-style LEGACY fixture, seeded on a disposable local PostgreSQL staged at
-- migration 0041 — the documented hosted baseline (see docs/architecture-v2/
-- HOSTED_SECDEF_PRIVILEGE_HOTFIX.md: "0038–0041 were owner-applied to the hosted database").
--
-- Purpose: a fresh 0001→0083 apply proves the migrations are internally consistent. It does NOT
-- prove they survive an upgrade over REAL DATA with REAL grants. This seeds the kinds of rows a
-- year-old deployment actually holds, so every later migration's backfills, fail-closed assertions
-- and reconciliation branches run against something rather than against nothing.
--
-- NEVER run against a hosted or staging database.

-- ── companies, people, memberships ───────────────────────────────────────────────────────────
insert into companies (id, name, base_currency) values
  ('aaaaaaaa-0000-0000-0000-000000000001','Legacy Construction (Pvt) Ltd','LKR'),
  ('aaaaaaaa-0000-0000-0000-000000000002','Legacy Trading','LKR');

insert into auth.users (id) values
  ('bbbbbbbb-0000-0000-0000-000000000001'),
  ('bbbbbbbb-0000-0000-0000-000000000002'),
  ('bbbbbbbb-0000-0000-0000-000000000003');
insert into users (id, full_name, is_active) values
  ('bbbbbbbb-0000-0000-0000-000000000001','Legacy Owner',true),
  ('bbbbbbbb-0000-0000-0000-000000000002','Legacy Finance',true),
  ('bbbbbbbb-0000-0000-0000-000000000003','Legacy Site Lead',true);

insert into memberships (id, company_id, user_id, status) values
  ('cccccccc-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000001','bbbbbbbb-0000-0000-0000-000000000001','active'),
  ('cccccccc-0000-0000-0000-000000000002','aaaaaaaa-0000-0000-0000-000000000001','bbbbbbbb-0000-0000-0000-000000000002','active'),
  ('cccccccc-0000-0000-0000-000000000003','aaaaaaaa-0000-0000-0000-000000000002','bbbbbbbb-0000-0000-0000-000000000003','active');
insert into membership_roles (membership_id, company_id, role_key) values
  ('cccccccc-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000001','owner_management'),
  ('cccccccc-0000-0000-0000-000000000002','aaaaaaaa-0000-0000-0000-000000000001','finance_reviewer'),
  ('cccccccc-0000-0000-0000-000000000003','aaaaaaaa-0000-0000-0000-000000000002','owner_management');

-- ── an approval policy and authority configuration ───────────────────────────────────────────
insert into approval_policies (company_id, version, policy, is_active) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 1,
   '{"company_id":"aaaaaaaa-0000-0000-0000-000000000001","currency":"LKR","version":1,
     "rules":[{"id":"legacy-expense","description":"legacy rule","priority":10,"event_types":null,
               "currency":"LKR","min_amount":null,"max_amount":null,"require_evidence":true,
               "auto_approve":false,"required_approver_roles":["finance_reviewer"],
               "approvals_required":1}]}'::jsonb, true);

-- ── inbound history: source events in EVERY legacy shape ─────────────────────────────────────
-- Including the two idempotency-key families migration 0076 must reconcile (`in_` and `evt_` for
-- one provider message), and a receipt with no provider message id at all.
insert into source_events (id, source, provider_message_id, company_id, raw_payload, content_hash,
                           idempotency_key, correlation_id, status, received_at)
values
  ('dddddddd-0000-0000-0000-000000000001','whatsapp','wamid.LEGACY001','aaaaaaaa-0000-0000-0000-000000000001',
   '{"id":"wamid.LEGACY001","from":"94770001111","text":"paid LKR 45,000 to Acme for cement"}'::jsonb,
   'h_legacy_001','in_legacy001','cor_legacy_001','received', now() - interval '200 days'),
  ('dddddddd-0000-0000-0000-000000000002','whatsapp','wamid.LEGACY001','aaaaaaaa-0000-0000-0000-000000000001',
   '{"id":"wamid.LEGACY001","from":"94770001111","text":"paid LKR 45,000 to Acme for cement"}'::jsonb,
   'h_legacy_001','evt_legacy001','cor_legacy_001','processed', now() - interval '200 days'),
  ('dddddddd-0000-0000-0000-000000000003','whatsapp',null,'aaaaaaaa-0000-0000-0000-000000000001',
   '{"from":"94770002222","text":"is the gate ready?"}'::jsonb,
   'h_legacy_003','in_legacy003','cor_legacy_003','received', now() - interval '150 days'),
  ('dddddddd-0000-0000-0000-000000000004','whatsapp','wamid.LEGACY004','aaaaaaaa-0000-0000-0000-000000000002',
   '{"id":"wamid.LEGACY004","from":"94770003333","text":"paid LKR 12,000 for fuel"}'::jsonb,
   'h_legacy_004','in_legacy004','cor_legacy_004','failed', now() - interval '90 days');

-- ── finance history: a drafted event, an approval and an approval action ─────────────────────
insert into financial_events (id, company_id, source_event_id, event_type, state, amount, currency,
                              transaction_date, counterparty_name, current_version, correlation_id)
values
  ('eeeeeeee-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000001',
   'dddddddd-0000-0000-0000-000000000002','expense_payment','awaiting_approval','45000.00','LKR',
   '2026-02-01','Acme Cement',1,'cor_legacy_001'),
  ('eeeeeeee-0000-0000-0000-000000000002','aaaaaaaa-0000-0000-0000-000000000001',
   null,'expense_payment','approved','8000.00','LKR','2026-03-11','Lanka Hardware',1,'cor_legacy_manual');

insert into financial_event_versions (financial_event_id, company_id, version, snapshot, change_reason)
values ('eeeeeeee-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000001',1,
        '{"amount":"45000.00"}'::jsonb,'legacy initial extraction');

insert into approval_requests (id, company_id, financial_event_id, status, approvals_required, submitted_by)
values ('ffffffff-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000001',
        'eeeeeeee-0000-0000-0000-000000000001','pending',1,'bbbbbbbb-0000-0000-0000-000000000002'),
       ('ffffffff-0000-0000-0000-000000000002','aaaaaaaa-0000-0000-0000-000000000001',
        'eeeeeeee-0000-0000-0000-000000000002','approved',1,'bbbbbbbb-0000-0000-0000-000000000002');

-- ── operational history: tasks and a management case ─────────────────────────────────────────
insert into tasks (id, company_id, title, status) values
  ('11111111-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000001','Legacy: chase the cement invoice','captured'),
  ('11111111-0000-0000-0000-000000000002','aaaaaaaa-0000-0000-0000-000000000001','Legacy: site inspection','captured'),
  ('11111111-0000-0000-0000-000000000003','aaaaaaaa-0000-0000-0000-000000000002','Legacy: fuel reconciliation','captured');

-- ── quotation + outbox history ───────────────────────────────────────────────────────────────
insert into quotations (id, company_id, quote_number, currency, status, public_token, total, sent_at)
values ('22222222-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000001','Q-LEGACY-1','LKR',
        'sent','tok_legacy_1','125000.00', now() - interval '120 days'),
       ('22222222-0000-0000-0000-000000000002','aaaaaaaa-0000-0000-0000-000000000001','Q-LEGACY-2','LKR',
        'draft','tok_legacy_2','0.00', null);

-- `idempotency_key` is the 0041-era column name; later migrations rename/extend around it, which is
-- exactly the kind of thing a fixture written against the CURRENT schema would have missed.
insert into message_outbox (id, company_id, channel, recipient, body, idempotency_key, status, created_at, sent_at)
values ('33333333-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000001','whatsapp',
        '94770001111','Your quotation Q-LEGACY-1 is attached.','wa_quote:Q-LEGACY-1','sent',
        now() - interval '120 days', now() - interval '120 days'),
       ('33333333-0000-0000-0000-000000000002','aaaaaaaa-0000-0000-0000-000000000001','whatsapp',
        -- 'pending' is the 0041-era status vocabulary; 'queued' arrives with a later migration.
        '94770002222','We have received your message.','wa_ack:legacy2','pending',
        now() - interval '10 days', null);

-- ── audit history ────────────────────────────────────────────────────────────────────────────
insert into audit_events (company_id, actor_type, actor_id, action, entity_type, entity_id, payload)
values ('aaaaaaaa-0000-0000-0000-000000000001','user','bbbbbbbb-0000-0000-0000-000000000001',
        'legacy.seeded','company','aaaaaaaa-0000-0000-0000-000000000001','{"note":"legacy fixture"}'::jsonb);
