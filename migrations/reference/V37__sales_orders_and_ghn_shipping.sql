-- Expand-only migration: prepare dedicated sales orders and GHN integration.
-- Existing SALE_ORDER documents, payments, deliveries and runtime behavior remain valid.
-- Backfill and application cutover must be performed separately.

create unique index sales_account_tenant_id_uq on identity.account(tenant_id,id);

create table retail.order_number_counter (
  tenant_id uuid not null references platform.tenant(id),
  number_year integer not null check(number_year between 2000 and 9999),
  last_value bigint not null check(last_value>0),
  primary key(tenant_id,number_year)
);

create table retail.sales_order (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references platform.tenant(id),
  order_number varchar(80) not null,
  source_quote_id uuid not null,
  source_quote_version integer not null check(source_quote_version>=0),
  legacy_document_id uuid,
  partner_id uuid not null,
  branch_id uuid not null,
  preferred_warehouse_id uuid,
  sales_owner_id uuid,
  channel varchar(30) not null default 'SALES'
    check(channel in ('SALES','COUNTER','ONLINE','WHOLESALE','COLLABORATOR')),
  status varchar(20) not null default 'DRAFT'
    check(status in ('DRAFT','CONFIRMED','CLOSED','CANCELLED')),
  currency varchar(3) not null default 'VND' check(currency='VND'),
  goods_gross numeric(20,0) not null default 0 check(goods_gross>=0),
  discount_total numeric(20,0) not null default 0 check(discount_total>=0),
  goods_net numeric(20,0) not null default 0 check(goods_net>=0),
  tax_total numeric(20,0) not null default 0 check(tax_total>=0),
  shipping_fee_charged numeric(20,0) not null default 0 check(shipping_fee_charged>=0),
  grand_total numeric(20,0) generated always as
    (goods_net+tax_total+shipping_fee_charged) stored,
  customer_snapshot jsonb not null check(jsonb_typeof(customer_snapshot)='object'),
  shipping_address_snapshot jsonb not null default '{}'
    check(jsonb_typeof(shipping_address_snapshot)='object'),
  note text not null default '',
  close_reason text,
  created_by uuid not null,
  confirmed_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  confirmed_at timestamptz,
  closed_at timestamptz,
  cancelled_at timestamptz,
  version integer not null default 0 check(version>=0),
  unique(tenant_id,id),
  unique(tenant_id,order_number),
  unique(tenant_id,source_quote_id),
  unique(tenant_id,legacy_document_id),
  check(discount_total<=goods_gross and goods_net=goods_gross-discount_total),
  foreign key(tenant_id,source_quote_id) references retail.document(tenant_id,id),
  foreign key(tenant_id,legacy_document_id) references retail.document(tenant_id,id),
  foreign key(tenant_id,partner_id) references retail.partner(tenant_id,id),
  foreign key(tenant_id,branch_id) references retail.branch(tenant_id,id),
  foreign key(tenant_id,preferred_warehouse_id) references retail.warehouse(tenant_id,id),
  foreign key(tenant_id,sales_owner_id) references identity.account(tenant_id,id),
  foreign key(tenant_id,created_by) references identity.account(tenant_id,id),
  foreign key(tenant_id,confirmed_by) references identity.account(tenant_id,id)
);

create table retail.sales_order_item (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  order_id uuid not null,
  source_quote_line_id uuid not null,
  legacy_line_id uuid,
  sku_id uuid not null,
  position integer not null check(position>=0),
  sku_snapshot jsonb not null check(jsonb_typeof(sku_snapshot)='object'),
  rule_snapshot jsonb not null default '{}' check(jsonb_typeof(rule_snapshot)='object'),
  unit varchar(40) not null,
  ratio numeric(20,4) not null check(ratio>0),
  qty numeric(20,4) not null check(qty>0),
  base_qty numeric(20,4) not null check(base_qty>0),
  unit_price numeric(20,4) not null check(unit_price>=0),
  -- Pre-discount, tax-exclusive amount; not necessarily qty*unit_price for tax-inclusive quotes.
  gross_amount numeric(20,0) not null check(gross_amount>=0),
  discount_amount numeric(20,0) not null default 0 check(discount_amount>=0),
  vat_rate numeric(8,4) not null check(vat_rate between 0 and 100),
  net_amount numeric(20,0) not null check(net_amount>=0),
  tax_amount numeric(20,0) not null check(tax_amount>=0),
  line_total numeric(20,0) generated always as (net_amount+tax_amount) stored,
  cancelled_base_qty numeric(20,4) not null default 0
    check(cancelled_base_qty>=0 and cancelled_base_qty<=base_qty),
  unique(tenant_id,id),
  unique(tenant_id,order_id,id,sku_id),
  unique(tenant_id,order_id,position),
  unique(tenant_id,order_id,source_quote_line_id),
  unique(tenant_id,legacy_line_id),
  check(base_qty=round(qty*ratio,4)),
  check(discount_amount<=gross_amount and net_amount=gross_amount-discount_amount),
  foreign key(tenant_id,order_id) references retail.sales_order(tenant_id,id),
  foreign key(tenant_id,source_quote_line_id) references retail.line(tenant_id,id),
  foreign key(tenant_id,legacy_line_id) references retail.line(tenant_id,id),
  foreign key(tenant_id,sku_id) references retail.sku(tenant_id,id)
);

create table retail.sales_order_event (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  order_id uuid not null,
  event_type varchar(60) not null,
  actor_id uuid,
  reason text,
  payload jsonb not null default '{}' check(jsonb_typeof(payload)='object'),
  idempotency_key varchar(120) not null,
  created_at timestamptz not null default now(),
  unique(tenant_id,order_id,idempotency_key),
  foreign key(tenant_id,order_id) references retail.sales_order(tenant_id,id),
  foreign key(tenant_id,actor_id) references identity.account(tenant_id,id)
);

-- Nullable bridge columns preserve legacy documents and POS. No backfill here.
alter table retail.document add column sales_order_id uuid;
alter table retail.document add constraint document_sales_order_fk
  foreign key(tenant_id,sales_order_id) references retail.sales_order(tenant_id,id);
create unique index document_order_link_uq on retail.document(tenant_id,id,sales_order_id);
alter table retail.line add column sales_order_id uuid;
alter table retail.line add column sales_order_item_id uuid;
alter table retail.line add constraint line_order_pair_ck check
  ((sales_order_id is null)=(sales_order_item_id is null));
alter table retail.line add constraint line_document_order_fk
  foreign key(tenant_id,document_id,sales_order_id)
    references retail.document(tenant_id,id,sales_order_id);
alter table retail.line add constraint line_order_item_fk
  foreign key(tenant_id,sales_order_id,sales_order_item_id,sku_id)
    references retail.sales_order_item(tenant_id,order_id,id,sku_id);
create unique index line_issue_sku_uq on retail.line(tenant_id,document_id,id,sku_id);

alter table retail.payment add column sales_order_id uuid;
alter table retail.payment add constraint payment_sales_order_fk
  foreign key(tenant_id,sales_order_id) references retail.sales_order(tenant_id,id);
alter table retail.commission add column sales_order_id uuid;
alter table retail.commission add constraint commission_sales_order_fk
  foreign key(tenant_id,sales_order_id) references retail.sales_order(tenant_id,id);
create unique index commission_sales_order_once on retail.commission(tenant_id,partner_id,sales_order_id)
  where kind='ORDER' and sales_order_id is not null;

create table retail.shipping_account (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references platform.tenant(id),
  carrier_code varchar(30) not null default 'GHN',
  name varchar(160) not null,
  environment varchar(20) not null check(environment in ('STAGING','PRODUCTION')),
  credential_ref text not null,
  webhook_secret_ref text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(tenant_id,id),
  unique(tenant_id,carrier_code,environment,name)
);

create table retail.shipping_shop (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  shipping_account_id uuid not null,
  branch_id uuid not null,
  warehouse_id uuid not null,
  external_shop_id bigint not null check(external_shop_id>0),
  shop_name varchar(160) not null,
  sender_snapshot jsonb not null check(jsonb_typeof(sender_snapshot)='object'),
  return_snapshot jsonb not null check(jsonb_typeof(return_snapshot)='object'),
  default_service_type_id integer,
  default_payment_type_id integer check(default_payment_type_id in (1,2)),
  default_required_note varchar(40),
  is_default boolean not null default false,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(tenant_id,id),
  unique(tenant_id,shipping_account_id,external_shop_id),
  unique(tenant_id,id,shipping_account_id),
  foreign key(tenant_id,shipping_account_id) references retail.shipping_account(tenant_id,id),
  foreign key(tenant_id,branch_id) references retail.branch(tenant_id,id),
  foreign key(tenant_id,warehouse_id) references retail.warehouse(tenant_id,id)
);
create unique index shipping_shop_default_uq on retail.shipping_shop(tenant_id,warehouse_id)
  where active and is_default;

-- Keep delivery_tenant_id_issue_id_key: current application assumes one delivery
-- per ISSUE. Relax it only in a later cutover migration with quantity/COD controls.
create unique index delivery_tenant_id_uq on retail.delivery(tenant_id,id);
alter table retail.delivery
  add column sales_order_id uuid,
  add column shipping_account_id uuid,
  add column shipping_shop_id uuid,
  add column client_order_code varchar(50),
  -- Existing tracking remains the carrier order code; do not store a second copy.
  add column integration_status varchar(20) not null default 'MANUAL'
    check(integration_status in ('MANUAL','DRAFT','QUEUED','CREATING','CREATED','UNKNOWN','ERROR')),
  add column carrier_status varchar(60),
  add column recipient_name varchar(1024),
  add column recipient_phone varchar(60),
  add column recipient_address varchar(1024),
  add column address_scheme varchar(30)
    check(address_scheme in ('VN_LEGACY_3_LEVEL','VN_NEW_2_LEVEL')),
  add column province_code varchar(40),
  add column province_name varchar(160),
  add column district_code varchar(40),
  add column district_name varchar(160),
  add column ward_code varchar(40),
  add column ward_name varchar(160),
  add column sender_snapshot jsonb check(jsonb_typeof(sender_snapshot)='object'),
  add column return_snapshot jsonb check(jsonb_typeof(return_snapshot)='object'),
  add column weight_gram integer check(weight_gram>0),
  add column length_cm integer check(length_cm>0),
  add column width_cm integer check(width_cm>0),
  add column height_cm integer check(height_cm>0),
  add column carrier_weight_gram integer check(carrier_weight_gram>=0),
  add column converted_weight_gram integer check(converted_weight_gram>=0),
  add column service_type_id integer,
  add column service_id integer,
  add column payment_type_id integer check(payment_type_id in (1,2)),
  add column required_note varchar(40),
  add column content varchar(2000),
  add column pick_shift jsonb not null default '[]' check(jsonb_typeof(pick_shift)='array'),
  add column pick_station_id integer,
  add column coupon varchar(100),
  add column insurance_value numeric(20,0) not null default 0 check(insurance_value>=0),
  add column order_value numeric(20,0) not null default 0 check(order_value>=0),
  add column cod_failed_amount numeric(20,0) not null default 0 check(cod_failed_amount>=0),
  add column carrier_cod_amount numeric(20,0) check(carrier_cod_amount>=0),
  add column carrier_fee_current numeric(20,0) check(carrier_fee_current>=0),
  add column carrier_fee_breakdown jsonb check(jsonb_typeof(carrier_fee_breakdown)='object'),
  add column settlement_status varchar(20) not null default 'UNRECONCILED'
    check(settlement_status in ('UNRECONCILED','PARTIAL','RECONCILED','DISPUTED')),
  add column carrier_status_at timestamptz,
  add column carrier_fee_at timestamptz,
  add column carrier_cod_at timestamptz,
  add column created_at timestamptz,
  add column updated_at timestamptz,
  add column carrier_created_at timestamptz,
  add column expected_delivery_at timestamptz,
  add column picked_at timestamptz,
  add column delivered_at timestamptz,
  add column returned_at timestamptz,
  add column cancelled_at timestamptz,
  add column last_synced_at timestamptz,
  add column last_error_code varchar(100),
  add column last_error_message text,
  add column replaces_delivery_id uuid,
  add column partial_return_code varchar(100),
  add column proof_of_delivery_url text;
-- Leave historical timestamps unknown; do not manufacture creation dates at upgrade.
alter table retail.delivery alter column created_at set default now();
alter table retail.delivery alter column updated_at set default now();
alter table retail.delivery add constraint delivery_order_fk
  foreign key(tenant_id,sales_order_id) references retail.sales_order(tenant_id,id);
alter table retail.delivery add constraint delivery_issue_order_fk
  foreign key(tenant_id,issue_id,sales_order_id)
    references retail.document(tenant_id,id,sales_order_id);
alter table retail.delivery add constraint delivery_account_fk
  foreign key(tenant_id,shipping_account_id) references retail.shipping_account(tenant_id,id);
alter table retail.delivery add constraint delivery_shop_fk
  foreign key(tenant_id,shipping_shop_id,shipping_account_id)
    references retail.shipping_shop(tenant_id,id,shipping_account_id);
alter table retail.delivery add constraint delivery_replacement_fk
  foreign key(tenant_id,replaces_delivery_id) references retail.delivery(tenant_id,id);
alter table retail.delivery add constraint delivery_account_shop_pair_ck check
  ((shipping_account_id is null)=(shipping_shop_id is null));
alter table retail.delivery add constraint delivery_integration_account_ck check
  (integration_status='MANUAL' or
   (shipping_account_id is not null and shipping_shop_id is not null and client_order_code is not null));
alter table retail.delivery add constraint delivery_created_tracking_ck check
  (integration_status<>'CREATED' or length(trim(tracking))>0);
create unique index delivery_shop_client_uq on retail.delivery
  (tenant_id,shipping_shop_id,client_order_code) where client_order_code is not null;
create unique index delivery_shop_tracking_uq on retail.delivery
  (tenant_id,shipping_shop_id,tracking) where shipping_shop_id is not null and tracking<>'';
create unique index delivery_issue_link_uq on retail.delivery(tenant_id,id,issue_id);
create unique index delivery_account_link_uq on retail.delivery(tenant_id,id,shipping_account_id);

create table retail.delivery_item (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  delivery_id uuid not null,
  issue_id uuid not null,
  issue_line_id uuid not null,
  sku_id uuid not null,
  quantity numeric(20,4) not null check(quantity>0),
  unit varchar(40) not null,
  ratio numeric(20,4) not null check(ratio>0),
  base_qty numeric(20,4) not null check(base_qty>0),
  carrier_item_quantity integer not null check(carrier_item_quantity>0),
  item_snapshot jsonb not null check(jsonb_typeof(item_snapshot)='object'),
  unique(tenant_id,id),
  unique(tenant_id,delivery_id,issue_line_id),
  check(base_qty=round(quantity*ratio,4)),
  foreign key(tenant_id,delivery_id,issue_id) references retail.delivery(tenant_id,id,issue_id),
  foreign key(tenant_id,issue_id,issue_line_id,sku_id)
    references retail.line(tenant_id,document_id,id,sku_id)
);
alter table retail.line add column delivery_item_id uuid;
alter table retail.line add constraint line_return_delivery_item_fk
  foreign key(tenant_id,delivery_item_id) references retail.delivery_item(tenant_id,id);

-- GHN callbacks are not internal outbox events: keep a dedicated durable inbox.
create table retail.shipping_event (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  shipping_account_id uuid not null,
  delivery_id uuid,
  external_shop_id bigint not null check(external_shop_id>0),
  carrier_order_code varchar(100) not null,
  client_order_code varchar(50),
  source varchar(20) not null default 'WEBHOOK' check(source in ('WEBHOOK','POLL','MANUAL')),
  event_type varchar(60) not null,
  carrier_status varchar(60),
  event_time timestamptz not null,
  received_at timestamptz not null default now(),
  reason_code varchar(100),
  reason text,
  payload jsonb not null check(jsonb_typeof(payload)='object'),
  payload_hash varchar(64) not null,
  dedup_key varchar(64) not null,
  processing_status varchar(20) not null default 'RECEIVED'
    check(processing_status in ('RECEIVED','PROCESSING','PROCESSED','UNMATCHED','ERROR')),
  attempts integer not null default 0 check(attempts>=0),
  next_retry_at timestamptz,
  processed_at timestamptz,
  last_error text,
  unique(tenant_id,id),
  unique(tenant_id,shipping_account_id,dedup_key),
  foreign key(tenant_id,shipping_account_id) references retail.shipping_account(tenant_id,id),
  foreign key(tenant_id,delivery_id,shipping_account_id)
    references retail.delivery(tenant_id,id,shipping_account_id)
);

-- One row per immutable logical API command; attempts reuse payload/key.
create table retail.shipping_request (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  shipping_account_id uuid not null,
  delivery_id uuid not null,
  operation varchar(30) not null
    check(operation in ('CREATE','UPDATE','CANCEL','UPDATE_COD','DETAIL','FEE','PRINT','REDELIVER','RETURN')),
  idempotency_key varchar(120) not null,
  request_hash varchar(64) not null,
  request_payload jsonb not null check(jsonb_typeof(request_payload)='object'),
  last_response_payload jsonb,
  status varchar(20) not null default 'QUEUED'
    check(status in ('QUEUED','RUNNING','SUCCEEDED','UNKNOWN','RETRY','FAILED','SUPERSEDED')),
  attempt_count integer not null default 0 check(attempt_count>=0),
  next_retry_at timestamptz,
  lease_owner varchar(120),
  lease_until timestamptz,
  http_status integer,
  carrier_error_code varchar(100),
  error_message text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  unique(tenant_id,id),
  unique(tenant_id,shipping_account_id,idempotency_key),
  foreign key(tenant_id,delivery_id,shipping_account_id)
    references retail.delivery(tenant_id,id,shipping_account_id)
);
create unique index shipping_request_active_create_uq on retail.shipping_request(tenant_id,delivery_id)
  where operation='CREATE' and status<>'SUPERSEDED';

create table retail.cod_reconciliation (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  shipping_account_id uuid not null,
  external_reference varchar(160) not null,
  source varchar(20) not null check(source in ('WEBHOOK','FILE','API','MANUAL')),
  period_from date,
  period_to date,
  status varchar(20) not null default 'DRAFT'
    check(status in ('DRAFT','MATCHED','DISPUTED','POSTED','CANCELLED')),
  cod_total numeric(20,0) not null default 0 check(cod_total>=0),
  fee_total numeric(20,0) not null default 0 check(fee_total>=0),
  adjustment_total numeric(20,0) not null default 0,
  net_total numeric(20,0) generated always as (cod_total-fee_total+adjustment_total) stored,
  bank_reference varchar(200),
  transferred_at timestamptz,
  source_payload jsonb,
  created_by uuid,
  confirmed_by uuid,
  created_at timestamptz not null default now(),
  confirmed_at timestamptz,
  version integer not null default 0 check(version>=0),
  unique(tenant_id,id),
  unique(tenant_id,id,shipping_account_id),
  unique(tenant_id,shipping_account_id,external_reference),
  check(period_to is null or period_from is null or period_to>=period_from),
  foreign key(tenant_id,shipping_account_id) references retail.shipping_account(tenant_id,id),
  foreign key(tenant_id,created_by) references identity.account(tenant_id,id),
  foreign key(tenant_id,confirmed_by) references identity.account(tenant_id,id)
);

-- Signed adjustments/net support fee-only settlements and later corrections.
create table retail.cod_reconciliation_line (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  reconciliation_id uuid not null,
  shipping_account_id uuid not null,
  delivery_id uuid,
  external_line_reference varchar(200) not null,
  carrier_order_code varchar(100) not null,
  entry_type varchar(30) not null check(entry_type in ('COD_TRANSFER','FEE','ADJUSTMENT','COMBINED')),
  cod_amount numeric(20,0) not null default 0 check(cod_amount>=0),
  fee_amount numeric(20,0) not null default 0 check(fee_amount>=0),
  adjustment_amount numeric(20,0) not null default 0,
  net_amount numeric(20,0) generated always as (cod_amount-fee_amount+adjustment_amount) stored,
  expected_net_amount numeric(20,0),
  difference_amount numeric(20,0) generated always as
    (cod_amount-fee_amount+adjustment_amount-expected_net_amount) stored,
  match_status varchar(20) not null default 'UNMATCHED'
    check(match_status in ('UNMATCHED','MATCHED','DISPUTED','POSTED')),
  receipt_payment_id uuid,
  fee_payment_id uuid,
  adjustment_payment_id uuid,
  raw_data jsonb,
  posted_at timestamptz,
  unique(tenant_id,id),
  unique(tenant_id,shipping_account_id,external_line_reference),
  unique(tenant_id,receipt_payment_id),
  unique(tenant_id,fee_payment_id),
  unique(tenant_id,adjustment_payment_id),
  foreign key(tenant_id,reconciliation_id,shipping_account_id)
    references retail.cod_reconciliation(tenant_id,id,shipping_account_id),
  foreign key(tenant_id,delivery_id,shipping_account_id)
    references retail.delivery(tenant_id,id,shipping_account_id),
  foreign key(tenant_id,receipt_payment_id) references retail.payment(tenant_id,id),
  foreign key(tenant_id,fee_payment_id) references retail.payment(tenant_id,id),
  foreign key(tenant_id,adjustment_payment_id) references retail.payment(tenant_id,id)
);

create index sales_order_list_idx on retail.sales_order(tenant_id,branch_id,status,created_at desc,id);
create index sales_order_customer_idx on retail.sales_order(tenant_id,partner_id,created_at desc);
create index sales_order_owner_idx on retail.sales_order(tenant_id,sales_owner_id,created_at desc);
create index sales_order_item_sku_idx on retail.sales_order_item(tenant_id,sku_id);
create index sales_order_event_time_idx on retail.sales_order_event(tenant_id,order_id,created_at,id);
create index document_sales_order_idx on retail.document(tenant_id,sales_order_id,type,status);
create index line_sales_order_item_idx on retail.line(tenant_id,sales_order_item_id);
create index line_delivery_item_idx on retail.line(tenant_id,delivery_item_id);
create index payment_sales_order_idx on retail.payment(tenant_id,sales_order_id);
create index commission_sales_order_idx on retail.commission(tenant_id,sales_order_id);
create index delivery_order_idx on retail.delivery(tenant_id,sales_order_id,created_at desc);
create index delivery_status_idx on retail.delivery(tenant_id,branch_id,status,updated_at);
create index delivery_item_issue_line_idx on retail.delivery_item(tenant_id,issue_line_id);
create index shipping_event_delivery_idx on retail.shipping_event(tenant_id,delivery_id,event_time,id);
create index shipping_event_pending_idx on retail.shipping_event(tenant_id,processing_status,next_retry_at)
  where processing_status in ('RECEIVED','UNMATCHED','ERROR');
create index shipping_request_pending_idx on retail.shipping_request(tenant_id,status,next_retry_at)
  where status in ('QUEUED','UNKNOWN','RETRY');
create index cod_batch_status_idx on retail.cod_reconciliation(tenant_id,status,created_at);
create index cod_line_batch_idx on retail.cod_reconciliation_line(tenant_id,reconciliation_id);
create index cod_line_delivery_idx on retail.cod_reconciliation_line(tenant_id,delivery_id);

-- Match the tenant GUC contract used by all existing retail tables.
do $$
declare tab text;
begin
  foreach tab in array array[
    'order_number_counter','sales_order','sales_order_item','sales_order_event',
    'shipping_account','shipping_shop','delivery_item','shipping_event',
    'shipping_request','cod_reconciliation','cod_reconciliation_line'
  ] loop
    execute format('alter table retail.%I enable row level security',tab);
    execute format('alter table retail.%I force row level security',tab);
    execute format('create policy tenant_scope on retail.%I using '
      || '(tenant_id=nullif(current_setting(''core.tenant_id'',true),'''')::uuid) '
      || 'with check (tenant_id=nullif(current_setting(''core.tenant_id'',true),'''')::uuid)',tab);
    if exists(select 1 from pg_roles where rolname='core_app') then
      execute format('grant select,insert,update on retail.%I to core_app',tab);
    end if;
  end loop;
  if exists(select 1 from pg_roles where rolname='core_app') then
    revoke update on retail.sales_order_event from core_app;
  end if;
end $$;
