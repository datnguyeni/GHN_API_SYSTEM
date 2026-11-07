-- A confirmed sale creates an internal shipping task, never an external order.
alter table retail.sales_order add column shipping_status varchar(20) not null default 'PENDING'
  check(shipping_status in ('PENDING','PREPARING','SHIPPING','PARTIAL','DELIVERED','FAILED'));
alter table retail.delivery add column external_shop_id bigint,
  add column carrier_environment varchar(20),
  add column carrier_partial_return boolean not null default false;

create table retail.shipping_order_queue (
  tenant_id uuid not null,
  sales_order_id uuid not null,
  created_at timestamptz not null default now(),
  primary key(tenant_id,sales_order_id),
  foreign key(tenant_id,sales_order_id) references retail.sales_order(tenant_id,id)
);
create function retail.enqueue_confirmed_shipping_order() returns trigger language plpgsql as $$
begin
  if new.status='CONFIRMED' then
    insert into retail.shipping_order_queue(tenant_id,sales_order_id) values(new.tenant_id,new.id)
      on conflict do nothing;
  end if;
  return new;
end $$;
create trigger sales_order_shipping_queue after insert or update of status on retail.sales_order
  for each row execute function retail.enqueue_confirmed_shipping_order();
insert into retail.shipping_order_queue(tenant_id,sales_order_id)
  select tenant_id,id from retail.sales_order where status='CONFIRMED' on conflict do nothing;

-- Each issued parcel can have several previews, but only one confirmed delivery.
create table retail.shipping_quote (
  id uuid primary key,
  tenant_id uuid not null,
  sales_order_id uuid not null,
  issue_id uuid not null,
  shipping_account_id uuid not null,
  shipping_shop_id uuid not null,
  external_shop_id bigint not null,
  environment varchar(20) not null,
  input_payload jsonb not null,
  request_payload jsonb not null,
  response_payload jsonb not null,
  total_fee numeric(20,0) not null check(total_fee>=0),
  created_by uuid not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now()+interval '15 minutes'),
  unique(tenant_id,id),
  foreign key(tenant_id,sales_order_id) references retail.sales_order(tenant_id,id),
  foreign key(tenant_id,issue_id,sales_order_id) references retail.document(tenant_id,id,sales_order_id),
  foreign key(tenant_id,shipping_shop_id,shipping_account_id) references retail.shipping_shop(tenant_id,id,shipping_account_id)
);
create index shipping_quote_order_idx on retail.shipping_quote(tenant_id,sales_order_id,created_at desc);
create index delivery_external_tracking_idx on retail.delivery(tenant_id,shipping_account_id,external_shop_id,tracking);
do $$
declare tab text;
begin
  foreach tab in array array['shipping_order_queue','shipping_quote'] loop
    execute format('alter table retail.%I enable row level security',tab);
    execute format('alter table retail.%I force row level security',tab);
    execute format('create policy tenant_scope on retail.%I using '
      || '(tenant_id=nullif(current_setting(''core.tenant_id'',true),'''')::uuid) '
      || 'with check (tenant_id=nullif(current_setting(''core.tenant_id'',true),'''')::uuid)',tab);
    if exists(select 1 from pg_roles where rolname='core_app') then
      execute format('grant select,insert,update on retail.%I to core_app',tab);
    end if;
  end loop;
end $$;
