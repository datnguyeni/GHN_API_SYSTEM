-- Preserve quoted carrier fee separately from fees recognized at reconciliation.
alter table retail.delivery add column actual_fee numeric(20,0) not null default 0 check(actual_fee>=0);
