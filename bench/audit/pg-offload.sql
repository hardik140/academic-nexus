drop table if exists fees, attendance;
create table fees (id uuid primary key default gen_random_uuid(), college_id int not null, student_id int not null,
  amount numeric(12,2) not null, paid_amount numeric(12,2) not null, status text not null, due_date date not null, created_at timestamptz default now());
-- college 1: 12k rows (1x), college 2: 120k (10x), college 3: 1.2M (100x)
insert into fees (college_id, student_id, amount, paid_amount, status, due_date)
select c, (g % (n/4)), 45000, (g % 9) * 5000, case when g % 5 = 0 then 'paid' else 'pending' end, date '2026-06-01' + (g % 240)
from (values (1, 12000), (2, 120000), (3, 1200000)) v(c, n), generate_series(1, n) g;
create index fees_college on fees (college_id);
create table attendance (id bigserial primary key, college_id int, marked_by int, student_id int, date date);
-- 1000 teachers per scale step; each teacher 30 students x 100 sessions = 3000 rows
insert into attendance (college_id, marked_by, student_id, date)
select 1, t, s, date '2026-06-01' + d from generate_series(1, 25) t, generate_series(1, 30) s, generate_series(1, 100) d;
insert into attendance (college_id, marked_by, student_id, date)
select 1, t, s, date '2026-06-01' + d from generate_series(26, 1000) t, generate_series(1, 30) s, generate_series(1, 100) d;
create index attendance_marked_by on attendance (marked_by);
vacuum analyze;
select college_id, count(*) from fees group by 1 order by 1;
select count(*) attendance_rows from attendance;
create or replace function bench(q text, n int default 7) returns numeric language plpgsql as $f$
declare t timestamptz; ms numeric[] := '{}'; i int;
begin
  execute q; -- warm
  for i in 1..n loop
    t := clock_timestamp(); execute q; ms := ms || extract(epoch from clock_timestamp() - t) * 1000;
  end loop;
  return round((select percentile_cont(0.5) within group (order by x) from unnest(ms) x)::numeric, 2);
end $f$;

\pset footer off
select c as college, (select count(*) from fees where college_id = c) as rows,
  bench(format('select json_agg(t) from (select amount, paid_amount, status, due_date from fees where college_id = %s) t', c)) as fetch_all_json_ms,
  (select pg_size_pretty(octet_length(json_agg(t)::text)::bigint) from (select amount, paid_amount, status, due_date from fees where college_id = c) t) as payload_all,
  bench(format('select sum(amount), sum(paid_amount), sum(amount - paid_amount) filter (where status <> ''paid'' and due_date < date ''2026-10-04'' and paid_amount < amount) from fees where college_id = %s', c)) as sql_aggregate_ms,
  bench(format('select count(*) from fees where college_id = %s', c)) as exact_count_ms,
  bench(format('select * from fees where college_id = %s order by due_date desc limit 25 offset 0', c)) as page_unindexed_sort_ms
from unnest(array[1,2,3]) c;

-- What PostgREST's default 1000-row cap does to the dashboard's totals (current code path).
select c as college,
  (select sum(amount) from fees where college_id = c) as true_billed,
  (select sum(amount) from (select amount from fees where college_id = c limit 1000) x) as billed_with_1000_row_cap
from unnest(array[1,2,3]) c;

create index fees_college_due on fees (college_id, due_date desc);
analyze fees;
select c as college, bench(format('select * from fees where college_id = %s order by due_date desc limit 25 offset 0', c)) as page_with_composite_index_ms from unnest(array[1,2,3]) c;

-- listFaculty: attendance rows for one page of 25 teachers vs the count it needs.
select
  bench('select json_agg(t) from (select marked_by, date from attendance where marked_by between 1 and 25) t') as fetch_rows_json_ms,
  (select pg_size_pretty(octet_length(json_agg(t)::text)::bigint) from (select marked_by, date from attendance where marked_by between 1 and 25) t) as payload,
  (select count(*) from attendance where marked_by between 1 and 25) as rows_needed_uncapped,
  bench('select marked_by, count(distinct date) from attendance where marked_by between 1 and 25 group by 1') as grouped_count_ms;
\pset footer off
create index attendance_marked_by_date on attendance (marked_by, date);
vacuum analyze attendance;
select bench('select marked_by, count(distinct date) from attendance where marked_by between 1 and 25 group by 1') as grouped_count_covering_index_ms;
-- summary table: what a trigger-maintained (or cron-refreshed) per-college aggregate costs to read
create table fee_summary as select college_id, sum(amount) billed, sum(paid_amount) collected from fees group by 1;
alter table fee_summary add primary key (college_id);
select bench('select * from fee_summary where college_id = 3') as summary_table_lookup_ms;
-- covering index for the aggregate itself
create index fees_college_cover on fees (college_id) include (amount, paid_amount, status, due_date);
vacuum analyze fees;
select c, bench(format('select sum(amount), sum(paid_amount) from fees where college_id = %s', c)) as aggregate_covering_index_ms from unnest(array[1,2,3]) c;
