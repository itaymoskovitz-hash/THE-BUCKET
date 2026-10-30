-- Security test for the price tables. Runs in one DO block and raises at the end, so everything rolls back.
-- Uses the throwaway test branch (chain 0000000000001, store 7) created by the ingest test.
do $test$
declare
  a uuid := gen_random_uuid(); b uuid := gen_random_uuid(); c uuid := gen_random_uuid();
  fam1 uuid; fam2 uuid; tok text; n int; r text := ''; ok boolean;
begin
  insert into auth.users(instance_id,id,aud,role,email,email_confirmed_at,created_at,updated_at) values
   ('00000000-0000-0000-0000-000000000000',a,'authenticated','authenticated','p_a@test.invalid',now(),now(),now()),
   ('00000000-0000-0000-0000-000000000000',b,'authenticated','authenticated','p_b@test.invalid',now(),now(),now()),
   ('00000000-0000-0000-0000-000000000000',c,'authenticated','authenticated','p_c@test.invalid',now(),now(),now());

  -- A owns fam1 and invites C as a member; B owns fam2
  perform set_config('request.jwt.claims', json_build_object('sub',a,'role','authenticated')::text, true);
  perform set_config('role','authenticated', true);
  fam1 := public.create_family('בדיקת מחירים א');
  select token into tok from public.create_invitation(fam1, 'p_c@test.invalid');
  perform set_config('role','none', true);
  perform set_config('request.jwt.claims', json_build_object('sub',c,'role','authenticated')::text, true);
  perform set_config('role','authenticated', true);
  perform public.accept_invitation(tok);
  perform set_config('role','none', true);
  perform set_config('request.jwt.claims', json_build_object('sub',b,'role','authenticated')::text, true);
  perform set_config('role','authenticated', true);
  fam2 := public.create_family('בדיקת מחירים ב');

  -- B: reads + search
  select count(*) into n from public.search_price_products('0000000000001','7','חלב', 10);
  r := r || format(E'01 signed-in user can search prices: %s\n', case when n >= 1 then 'PASS' else 'FAIL' end);
  begin insert into public.price_products(chain_id,store_id,item_code,name,price) values ('0000000000001','7','1','x',1); ok := false;
  exception when others then ok := true; end;
  r := r || format(E'02 user cannot insert prices: %s\n', case when ok then 'PASS' else 'FAIL' end);
  begin update public.price_products set price = 0.01 where chain_id = '0000000000001'; get diagnostics n = row_count; ok := n = 0;
  exception when others then ok := true; end;
  r := r || format(E'03 user cannot change prices: %s\n', case when ok then 'PASS' else 'FAIL' end);
  begin insert into public.price_stores(chain_id,store_id,name) values ('x','1','x'); ok := false;
  exception when others then ok := true; end;
  r := r || format(E'04 user cannot insert stores: %s\n', case when ok then 'PASS' else 'FAIL' end);
  begin select count(*) into n from public.price_ingest_tokens; ok := false; exception when others then ok := true; end;
  r := r || format(E'05 user cannot read ingest tokens: %s\n', case when ok then 'PASS' else 'FAIL' end);
  begin select count(*) into n from public.price_import_log; ok := false; exception when others then ok := true; end;
  r := r || format(E'06 user cannot read import log: %s\n', case when ok then 'PASS' else 'FAIL' end);
  begin perform public.set_family_store(fam1, '0000000000001', '7'); ok := false; exception when others then ok := sqlerrm = 'NOT_OWNER'; end;
  r := r || format(E'07 outsider cannot set another family''s branch: %s\n', case when ok then 'PASS' else 'FAIL' end);
  begin insert into public.family_item_links(family_id,name_key,item_code) values (fam1,'חלב','9000000000999'); ok := false;
  exception when others then ok := true; end;
  r := r || format(E'08 outsider cannot add links to another family: %s\n', case when ok then 'PASS' else 'FAIL' end);

  -- C (member, not owner)
  perform set_config('role','none', true);
  perform set_config('request.jwt.claims', json_build_object('sub',c,'role','authenticated')::text, true);
  perform set_config('role','authenticated', true);
  begin perform public.set_family_store(fam1, '0000000000001', '7'); ok := false; exception when others then ok := sqlerrm = 'NOT_OWNER'; end;
  r := r || format(E'09 member cannot change branch: %s\n', case when ok then 'PASS' else 'FAIL' end);
  begin update public.families set price_store_id = '7', price_chain_id = '0000000000001' where id = fam1; ok := false;
  exception when others then ok := true; end;
  r := r || format(E'10 branch cannot be set by direct update: %s\n', case when ok then 'PASS' else 'FAIL' end);
  insert into public.family_item_links(family_id,name_key,item_code) values (fam1,'חלב','9000000000999');
  select count(*) into n from public.family_item_links where family_id = fam1;
  r := r || format(E'11 member can save a product link: %s\n', case when n = 1 then 'PASS' else 'FAIL' end);

  -- A (owner)
  perform set_config('role','none', true);
  perform set_config('request.jwt.claims', json_build_object('sub',a,'role','authenticated')::text, true);
  perform set_config('role','authenticated', true);
  begin perform public.set_family_store(fam1, '0000000000001', '99999'); ok := false; exception when others then ok := sqlerrm = 'STORE_NOT_FOUND'; end;
  r := r || format(E'12 unknown branch rejected: %s\n', case when ok then 'PASS' else 'FAIL' end);
  perform public.set_family_store(fam1, '0000000000001', '7');
  select count(*) into n from public.families where id = fam1 and price_store_id = '7';
  r := r || format(E'13 owner can choose branch: %s\n', case when n = 1 then 'PASS' else 'FAIL' end);

  -- B cannot see fam1 links
  perform set_config('role','none', true);
  perform set_config('request.jwt.claims', json_build_object('sub',b,'role','authenticated')::text, true);
  perform set_config('role','authenticated', true);
  select count(*) into n from public.family_item_links;
  r := r || format(E'14 other family''s links are hidden: %s\n', case when n = 0 then 'PASS' else 'FAIL' end);

  -- anonymous
  perform set_config('role','none', true);
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  perform set_config('role','anon', true);
  begin select count(*) into n from public.price_products; ok := false; exception when others then ok := true; end;
  r := r || format(E'15 anonymous cannot read prices: %s\n', case when ok then 'PASS' else 'FAIL' end);
  begin perform public.search_price_products('0000000000001','7','חלב', 10); ok := false; exception when others then ok := true; end;
  r := r || format(E'16 anonymous cannot search: %s\n', case when ok then 'PASS' else 'FAIL' end);

  perform set_config('role','none', true);
  raise exception E'PRICE TEST REPORT (rolled back)\n%', r;
end $test$;
