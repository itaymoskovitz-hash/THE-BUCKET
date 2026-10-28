-- RLS / RPC security test. Runs entirely inside one DO block and ends by raising
-- an exception carrying the report, so EVERYTHING it created is rolled back.
do $test$
declare
  a uuid := gen_random_uuid(); b uuid := gen_random_uuid(); c uuid := gen_random_uuid();
  d uuid := gen_random_uuid(); e uuid := gen_random_uuid(); u uuid := gen_random_uuid();
  fam1 uuid; fam2 uuid; item1 uuid; item2 uuid; tok text; inv uuid; n int; r text := ''; ok boolean;
begin
  insert into auth.users(instance_id,id,aud,role,email,email_confirmed_at,created_at,updated_at) values
   ('00000000-0000-0000-0000-000000000000',a,'authenticated','authenticated','t_a@test.invalid',now(),now(),now()),
   ('00000000-0000-0000-0000-000000000000',b,'authenticated','authenticated','t_b@test.invalid',now(),now(),now()),
   ('00000000-0000-0000-0000-000000000000',c,'authenticated','authenticated','t_c@test.invalid',now(),now(),now()),
   ('00000000-0000-0000-0000-000000000000',d,'authenticated','authenticated','t_d@test.invalid',now(),now(),now()),
   ('00000000-0000-0000-0000-000000000000',e,'authenticated','authenticated','t_e@test.invalid',now(),now(),now()),
   ('00000000-0000-0000-0000-000000000000',u,'authenticated','authenticated','t_u@test.invalid',null,now(),now());

  -- helper: become a user
  -- (inline: set_config role + claims)
  perform set_config('request.jwt.claims', json_build_object('sub',a,'role','authenticated')::text, true);
  perform set_config('role','authenticated', true);
  fam1 := public.create_family('משפחת א');
  insert into public.shopping_items(family_id,name,category) values (fam1,'חלב',2) returning id into item1;
  r := r || format(E'01 create family + add item (A): PASS\n');

  perform set_config('role','none', true);
  perform set_config('request.jwt.claims', json_build_object('sub',b,'role','authenticated')::text, true);
  perform set_config('role','authenticated', true);
  fam2 := public.create_family('משפחת ב');
  insert into public.shopping_items(family_id,name) values (fam2,'לחם') returning id into item2;

  select count(*) into n from public.shopping_items where family_id = fam1;
  r := r || format(E'02 B cannot read family1 items: %s\n', case when n=0 then 'PASS' else 'FAIL' end);
  select count(*) into n from public.families where id = fam1;
  r := r || format(E'03 B cannot read family1 row: %s\n', case when n=0 then 'PASS' else 'FAIL' end);
  update public.shopping_items set name='hacked' where id = item1; get diagnostics n = row_count;
  r := r || format(E'04 B cannot edit family1 item: %s\n', case when n=0 then 'PASS' else 'FAIL' end);
  delete from public.shopping_items where id = item1; get diagnostics n = row_count;
  r := r || format(E'05 B cannot delete family1 item: %s\n', case when n=0 then 'PASS' else 'FAIL' end);
  begin insert into public.shopping_items(family_id,name) values (fam1,'x'); ok := false;
  exception when others then ok := true; end;
  r := r || format(E'06 B cannot insert into family1: %s\n', case when ok then 'PASS' else 'FAIL' end);
  begin insert into public.family_members(family_id,user_id,role) values (fam1,b,'owner'); ok := false;
  exception when others then ok := true; end;
  r := r || format(E'07 B cannot insert own membership directly: %s\n', case when ok then 'PASS' else 'FAIL' end);
  begin update public.shopping_items set family_id = fam1 where id = item2; exception when others then null; end;
  perform set_config('role','none', true);
  select count(*) into n from public.shopping_items where id = item2 and family_id = fam2;
  r := r || format(E'08 B cannot move own item into family1: %s\n', case when n=1 then 'PASS' else 'FAIL' end);
  perform set_config('role','authenticated', true);
  begin perform * from public.list_family_members(fam1); ok := false; exception when others then ok := true; end;
  r := r || format(E'09 B cannot list family1 members: %s\n', case when ok then 'PASS' else 'FAIL' end);
  begin perform public.create_invitation(fam1,'t_b2@test.invalid'); ok := false; exception when others then ok := true; end;
  r := r || format(E'10 B cannot invite into family1: %s\n', case when ok then 'PASS' else 'FAIL' end);

  -- A invites C
  perform set_config('role','none', true);
  perform set_config('request.jwt.claims', json_build_object('sub',a,'role','authenticated')::text, true);
  perform set_config('role','authenticated', true);
  select token, invitation_id into tok, inv from public.create_invitation(fam1,'T_C@test.invalid ');
  perform set_config('role','none', true);
  select count(*) into n from public.family_invitations where id = inv and token_hash <> tok and length(token_hash)=64;
  r := r || format(E'11 invitation stores hash, not raw token: %s\n', case when n=1 then 'PASS' else 'FAIL' end);

  -- D (wrong email) tries the token
  perform set_config('request.jwt.claims', json_build_object('sub',d,'role','authenticated')::text, true);
  perform set_config('role','authenticated', true);
  begin perform public.accept_invitation(tok); ok := false;
  exception when others then ok := sqlerrm = 'INVITE_WRONG_EMAIL'; end;
  r := r || format(E'12 wrong email rejected: %s\n', case when ok then 'PASS' else 'FAIL' end);
  begin perform public.accept_invitation(repeat('a',64)); ok := false;
  exception when others then ok := sqlerrm = 'INVITE_INVALID'; end;
  r := r || format(E'13 guessed token rejected: %s\n', case when ok then 'PASS' else 'FAIL' end);

  -- C accepts
  perform set_config('role','none', true);
  perform set_config('request.jwt.claims', json_build_object('sub',c,'role','authenticated')::text, true);
  perform set_config('role','authenticated', true);
  ok := public.accept_invitation(tok) = fam1;
  select count(*) into n from public.shopping_items where family_id = fam1;
  r := r || format(E'14 intended email accepts + sees items: %s\n', case when ok and n=1 then 'PASS' else 'FAIL' end);
  begin perform public.accept_invitation(tok); ok := false;
  exception when others then ok := sqlerrm = 'INVITE_USED'; end;
  r := r || format(E'15 used invitation rejected: %s\n', case when ok then 'PASS' else 'FAIL' end);
  update public.shopping_items set purchased = true where id = item1;
  select count(*) into n from public.shopping_items where id = item1 and purchased and purchased_at is not null;
  update public.shopping_items set purchased = false where id = item1;
  select n + count(*) into n from public.shopping_items where id = item1 and not purchased and purchased_at is null;
  r := r || format(E'16 member can purchase/restore item: %s\n', case when n=2 then 'PASS' else 'FAIL' end);
  begin update public.family_members set role='owner' where user_id = c; ok := false;
  exception when others then ok := true; end;
  r := r || format(E'17 member cannot self-promote to owner: %s\n', case when ok then 'PASS' else 'FAIL' end);
  begin perform public.transfer_ownership(fam1, c); ok := false; exception when others then ok := sqlerrm='NOT_OWNER'; end;
  r := r || format(E'18 member cannot transfer ownership: %s\n', case when ok then 'PASS' else 'FAIL' end);
  begin perform public.remove_member(fam1, a); ok := false; exception when others then ok := sqlerrm='NOT_OWNER'; end;
  r := r || format(E'19 member cannot remove owner: %s\n', case when ok then 'PASS' else 'FAIL' end);
  select count(*) into n from public.family_invitations;
  r := r || format(E'20 member cannot see invitations: %s\n', case when n=0 then 'PASS' else 'FAIL' end);
  begin update public.families set created_by = c where id = fam1; get diagnostics n = row_count; ok := n=0;
  exception when others then ok := true; end;
  r := r || format(E'21 member cannot alter family row: %s\n', case when ok then 'PASS' else 'FAIL' end);

  -- expired + revoked + unconfirmed
  perform set_config('role','none', true);
  perform set_config('request.jwt.claims', json_build_object('sub',a,'role','authenticated')::text, true);
  perform set_config('role','authenticated', true);
  select token, invitation_id into tok, inv from public.create_invitation(fam1,'t_e@test.invalid');
  perform set_config('role','none', true);
  update public.family_invitations set expires_at = now() - interval '1 minute' where id = inv;
  perform set_config('request.jwt.claims', json_build_object('sub',e,'role','authenticated')::text, true);
  perform set_config('role','authenticated', true);
  begin perform public.accept_invitation(tok); ok := false; exception when others then ok := sqlerrm='INVITE_EXPIRED'; end;
  r := r || format(E'22 expired invitation rejected: %s\n', case when ok then 'PASS' else 'FAIL' end);

  perform set_config('role','none', true);
  perform set_config('request.jwt.claims', json_build_object('sub',a,'role','authenticated')::text, true);
  perform set_config('role','authenticated', true);
  select token, invitation_id into tok, inv from public.create_invitation(fam1,'t_e@test.invalid');
  perform public.revoke_invitation(inv);
  perform set_config('role','none', true);
  perform set_config('request.jwt.claims', json_build_object('sub',e,'role','authenticated')::text, true);
  perform set_config('role','authenticated', true);
  begin perform public.accept_invitation(tok); ok := false; exception when others then ok := sqlerrm='INVITE_REVOKED'; end;
  r := r || format(E'23 revoked invitation rejected: %s\n', case when ok then 'PASS' else 'FAIL' end);

  perform set_config('role','none', true);
  perform set_config('request.jwt.claims', json_build_object('sub',a,'role','authenticated')::text, true);
  perform set_config('role','authenticated', true);
  select token into tok from public.create_invitation(fam1,'t_u@test.invalid');
  begin perform public.leave_family(fam1); ok := false; exception when others then ok := sqlerrm='OWNER_CANNOT_LEAVE'; end;
  r := r || format(E'24 owner cannot leave without transfer: %s\n', case when ok then 'PASS' else 'FAIL' end);
  perform set_config('role','none', true);
  perform set_config('request.jwt.claims', json_build_object('sub',u,'role','authenticated')::text, true);
  perform set_config('role','authenticated', true);
  begin perform public.accept_invitation(tok); ok := false; exception when others then ok := sqlerrm='EMAIL_NOT_CONFIRMED'; end;
  r := r || format(E'25 unconfirmed email cannot accept: %s\n', case when ok then 'PASS' else 'FAIL' end);

  -- anonymous (not logged in)
  perform set_config('role','none', true);
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  perform set_config('role','anon', true);
  begin select count(*) into n from public.shopping_items; ok := false; exception when others then ok := true; end;
  r := r || format(E'26 anonymous cannot read items: %s\n', case when ok then 'PASS' else 'FAIL' end);
  begin perform public.create_family('x'); ok := false; exception when others then ok := true; end;
  r := r || format(E'27 anonymous cannot call RPCs: %s\n', case when ok then 'PASS' else 'FAIL' end);

  -- ownership transfer works
  perform set_config('role','none', true);
  perform set_config('request.jwt.claims', json_build_object('sub',a,'role','authenticated')::text, true);
  perform set_config('role','authenticated', true);
  perform public.transfer_ownership(fam1, c);
  ok := not public.is_family_owner(fam1);
  r := r || format(E'28 owner can transfer ownership: %s\n', case when ok then 'PASS' else 'FAIL' end);

  perform set_config('role','none', true);
  raise exception E'TEST REPORT (rolled back)\n%', r;
end $test$;
