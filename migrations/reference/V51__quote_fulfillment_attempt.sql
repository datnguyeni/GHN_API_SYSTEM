-- Durable carrier reconciliation survives a rolled-back sales transaction.
-- Business records (acceptance/order/issue/receivable/delivery) still commit together.
create table retail.quote_fulfillment_attempt (
  tenant_id uuid not null,
  quote_id uuid not null,
  status varchar(20) not null default 'NEW'
    check(status in ('NEW','PREPARED','CREATING','UNKNOWN','CREATED','COMPLETED','REJECTED')),
  input_payload jsonb not null check(jsonb_typeof(input_payload)='object'),
  prepared_payload jsonb,
  carrier_response jsonb,
  result_payload jsonb,
  lease_token uuid,
  lease_until timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key(tenant_id,quote_id),
  foreign key(tenant_id,quote_id) references retail.document(tenant_id,id)
);
alter table retail.quote_fulfillment_attempt enable row level security;
alter table retail.quote_fulfillment_attempt force row level security;
create policy tenant_scope on retail.quote_fulfillment_attempt
  using(tenant_id=nullif(current_setting('core.tenant_id',true),'')::uuid)
  with check(tenant_id=nullif(current_setting('core.tenant_id',true),'')::uuid);
do $$ begin
  if exists(select 1 from pg_roles where rolname='core_app') then
    grant select,insert,update on retail.quote_fulfillment_attempt to core_app;
  end if;
end $$;
