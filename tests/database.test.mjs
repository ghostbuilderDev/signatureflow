import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
const u = "00000000-0000-4000-8000-000000000001",
  other = "00000000-0000-4000-8000-000000000002",
  doc = "10000000-0000-4000-8000-000000000001",
  a = "20000000-0000-4000-8000-000000000001",
  b = "20000000-0000-4000-8000-000000000002";
test("migration, RLS, atomic save, concurrent lease, hash checks and cancellation", async () => {
  const db = new PGlite();
  await db.exec(
    `create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create schema storage;create table auth.users(id uuid primary key);create function auth.uid() returns uuid language sql as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);create table storage.objects(id uuid,name text,bucket_id text);alter table storage.objects enable row level security;create function storage.foldername(text) returns text[] language sql as $$select string_to_array($1,'/')$$;grant usage on schema auth,storage,public to authenticated,anon,service_role;grant execute on function auth.uid() to authenticated,service_role;`,
  );
  const base = (
    await readFile(
      "supabase/migrations/20260918182400_signatureflow.sql",
      "utf8",
    )
  ).replace("create extension if not exists pgcrypto;", "");
  await db.exec(base);
  await db.exec(
    await readFile(
      "supabase/migrations/20261120023410_signatureflow_v2.sql",
      "utf8",
    ),
  );
  await db.exec(
    `insert into auth.users values('${u}'),('${other}'); set role authenticated;select set_config('request.jwt.claim.sub','${u}',false);`,
  );
  await db.exec(
    `insert into signatureflow_documents(id,owner_id,name,storage_path,current_storage_path,page_count) values('${doc}','${u}','Test','${u}/${doc}/original.pdf','${u}/${doc}/original.pdf',2);insert into signatureflow_signers(id,document_id,name,email,signing_order) values('${a}','${doc}','Alice','a@example.fr',1),('${b}','${doc}','Bob','b@example.fr',2);`,
  );
  const fields = [a, b].map((id, i) => ({
    id: `30000000-0000-4000-8000-00000000000${i + 1}`,
    signer_id: id,
    page: 1,
    x: 0.1 + i * 0.4,
    y: 0.5,
    width: 0.3,
    height: 0.1,
    kind: "signature",
    required: true,
  }));
  await db.query("select signatureflow_save_fields($1,$2)", [
    doc,
    JSON.stringify(fields),
  ]);
  await assert.rejects(
    db.query("select signatureflow_save_fields($1,$2)", [
      doc,
      JSON.stringify([{ ...fields[0], page: 99 }]),
    ]),
  );
  assert.equal(
    (
      await db.query(
        "select count(*)::int as n from signatureflow_signature_fields",
      )
    ).rows[0].n,
    2,
    "failed save preserves old zones",
  );
  await db.exec(`select set_config('request.jwt.claim.sub','${other}',false)`);
  assert.equal(
    (await db.query("select * from signatureflow_documents")).rows.length,
    0,
    "other owner cannot read",
  );
  await assert.rejects(
    db.query("select signatureflow_claim($1,$2,$3,$4)", [
      "abc",
      crypto.randomUUID(),
      crypto.randomUUID(),
      "h",
    ]),
  );
  await db.exec(`reset role;set role service_role;`);
  const links = [a, b].map((id, i) => ({
    id,
    hash: "hash" + i,
    expires: new Date(Date.now() + 86400000).toISOString(),
  }));
  const manifest = (
    await db.query(
      "select id,signer_id,page,x,y,width,height,kind,required from signatureflow_signature_fields order by id",
    )
  ).rows;
  await db.query("select signatureflow_issue($1,$2,$3,$4,$5,$6)", [
    doc,
    u,
    JSON.stringify(links),
    "h1",
    2,
    JSON.stringify(manifest),
  ]);
  await db.exec("update signatureflow_documents set signing_mode='sequential'");
  await assert.rejects(
    db.query("select signatureflow_claim($1,$2,$3,$4)", [
      "hash1",
      crypto.randomUUID(),
      crypto.randomUUID(),
      "h1",
    ]),
    /précédent/,
  );
  await db.exec("update signatureflow_documents set signing_mode='parallel'");
  const lease = crypto.randomUUID(),
    request = crypto.randomUUID();
  await db.query("select signatureflow_claim($1,$2,$3,$4)", [
    "hash0",
    request,
    lease,
    "h1",
  ]);
  await assert.rejects(
    db.query("select signatureflow_claim($1,$2,$3,$4)", [
      "hash1",
      crypto.randomUUID(),
      crypto.randomUUID(),
      "h1",
    ]),
    /en cours/,
  );
  await assert.rejects(
    db
      .query("select signatureflow_release($1,$2,$3)", [
        doc,
        a,
        crypto.randomUUID(),
      ])
      .then(async () => {
        await db.query("select signatureflow_claim($1,$2,$3,$4)", [
          "hash1",
          crypto.randomUUID(),
          crypto.randomUUID(),
          "h1",
        ]);
      }),
    /en cours/,
    "wrong lease cannot unlock",
  );
  await db.query("select signatureflow_finish($1,$2,$3,$4,$5,$6,$7,$8,$9)", [
    doc,
    a,
    lease,
    "signed-a.pdf",
    "h1",
    "h2",
    "Alice",
    new Date().toISOString(),
    "{}",
  ]);
  const repeat = (
    await db.query("select signatureflow_claim($1,$2,$3,$4) as r", [
      "hash0",
      request,
      crypto.randomUUID(),
      "h1",
    ])
  ).rows[0].r;
  assert.equal(
    repeat.alreadySigned,
    true,
    "lost response retries are idempotent",
  );
  await assert.rejects(
    db.query("select signatureflow_claim($1,$2,$3,$4)", [
      "hash1",
      crypto.randomUUID(),
      crypto.randomUUID(),
      "h1",
    ]),
    /a changé/,
  );
  const lb = crypto.randomUUID();
  await db.query("select signatureflow_claim($1,$2,$3,$4)", [
    "hash1",
    crypto.randomUUID(),
    lb,
    "h2",
  ]);
  await db.query("select signatureflow_release($1,$2,$3)", [doc, b, lb]);
  await db.exec(
    `reset role;set role authenticated;select set_config('request.jwt.claim.sub','${u}',false);`,
  );
  await assert.rejects(
    db.query("select signatureflow_save_fields($1,$2)", [
      doc,
      JSON.stringify(fields),
    ]),
    /non modifiable/,
  );
  await assert.rejects(
    db.query("update signatureflow_signers set token_hash='evil' where id=$1", [
      a,
    ]),
    /permission/,
  );
  await db.exec(`reset role;set role service_role;`);
  await db.query("select signatureflow_cancel($1,$2)", [doc, u]);
  await assert.rejects(
    db.query("select signatureflow_claim($1,$2,$3,$4)", [
      "hash1",
      crypto.randomUUID(),
      crypto.randomUUID(),
      "h2",
    ]),
    /invalide/,
  );
  assert.equal(
    (await db.query("select status from signatureflow_documents")).rows[0]
      .status,
    "cancelled",
  );
  await db.close();
});
