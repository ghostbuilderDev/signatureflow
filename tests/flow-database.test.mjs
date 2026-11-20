import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
const uid = "00000000-0000-4000-8000-000000000001",
  site = "00000000-0000-4000-8000-000000000002",
  folder = "00000000-0000-4000-8000-000000000003";
const documentId = "10000000-0000-4000-8000-000000000001",
  v1 = "10000000-0000-4000-8000-000000000002",
  v2 = "10000000-0000-4000-8000-000000000003";
const campaign = "20000000-0000-4000-8000-000000000001",
  envelope = "20000000-0000-4000-8000-000000000002",
  signer = "20000000-0000-4000-8000-000000000003",
  field = "20000000-0000-4000-8000-000000000004";
test("JDC migration: isolation, atomic issue, evidence jobs, reissue, superseded tokens and snapshot protection", async () => {
  const db = new PGlite();
  await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create schema storage;create table auth.users(id uuid primary key);create function auth.uid() returns uuid language sql as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);create table storage.objects(id uuid,name text,bucket_id text);alter table storage.objects enable row level security;create function storage.foldername(text) returns text[] language sql as $$select string_to_array($1,'/')$$;grant usage on schema auth,storage,public to authenticated,anon,service_role;
 create table chantiers(id uuid primary key);create table chantier_document_folders(id uuid primary key,chantier_id uuid);create table chantier_documents(id uuid primary key,chantier_id uuid,folder_id uuid,storage_path text,file_name text,mime_type text,bytes bigint,description text,version_label text,created_by uuid,created_by_name text);
 create function journal_can_manage_chantier_documents(uuid) returns boolean language sql as $$select coalesce(current_setting('test.can_manage',true),'')='yes'$$;`);
  for (const name of (await readdir("supabase/migrations"))
    .filter((n) => /^\d{14}_signatureflow.*\.sql$/.test(n))
    .sort())
    await db.exec(
      (await readFile("supabase/migrations/" + name, "utf8")).replace(
        "create extension if not exists pgcrypto;",
        "",
      ),
    );
  await db.exec(
    `insert into auth.users values('${uid}');insert into chantiers values('${site}');insert into chantier_document_folders values('${folder}','${site}');insert into sf3_documents values('${documentId}','${uid}','${site}','${folder}','ISF test','ISF',null,now());insert into sf3_versions(id,document_id,label,source_path,source_sha256,source_pages,state) values('${v1}','${documentId}','A','original1.pdf','${"a".repeat(64)}',1,'draft'),('${v2}','${documentId}','B','original2.pdf','${"b".repeat(64)}',1,'draft');grant all on all tables in schema public to service_role;grant usage,select on all sequences in schema public to service_role;set role service_role;`,
  );
  await db.query("select sf3_publish_version($1,null,$2)", [v1, uid]);
  await db.query("select sf3_publish_version($1,$1,$2)", [v1, uid]);
  assert.equal(
    (await db.query("select previous_id from sf3_versions where id=$1", [v1]))
      .rows[0].previous_id,
    null,
    "publishing twice does not create self-reference",
  );
  const fields = [
    {
      id: field,
      signer_id: signer,
      page: 1,
      x: 0.1,
      y: 0.1,
      width: 0.5,
      height: 0.1,
      kind: "signature",
      required: true,
    },
  ];
  const env = {
    id: envelope,
    name: "ISF - Annexe",
    path: `${uid}/${envelope}/original.pdf`,
    sha256: "c".repeat(64),
    pages: 1,
    annex_start: 0,
    signers: [
      {
        id: signer,
        name: "Externe",
        email: "externe@example.fr",
        role: "RSO",
        order: 1,
        company: "Entreprise extérieure",
      },
    ],
    fields,
  };
  const signer2 = "20000000-0000-4000-8000-000000000005";
  env.signers.push({
    ...env.signers[0],
    id: signer2,
    email: "second@example.fr",
    name: "Second",
    order: 2,
  });
  fields.push({
    ...fields[0],
    id: "20000000-0000-4000-8000-000000000006",
    signer_id: signer2,
    y: 0.4,
  });
  await db.query("select sf3_register_campaign($1,$2)", [
    JSON.stringify({
      id: campaign,
      version_id: v1,
      owner_id: uid,
      mode: "acknowledgement",
    }),
    JSON.stringify([env]),
  ]);
  await db.exec(
    `update signatureflow_documents set prepared_at=now() where id='${envelope}'`,
  );
  const links = [
    {
      id: signer,
      hash: "d".repeat(64),
      expires: new Date(Date.now() + 86400000).toISOString(),
    },
  ];
  links.push({ ...links[0], id: signer2, hash: "e".repeat(64) });
  // Invalid capture rolls back BOTH token assignment and issue.
  await assert.rejects(
    db.query("select sf3_issue($1,$2,$3,$4,1,$5,$6)", [
      envelope,
      uid,
      JSON.stringify(links),
      "c".repeat(64),
      JSON.stringify(fields),
      JSON.stringify([{ id: field, cipher: "invalid", hash: "d".repeat(64) }]),
    ]),
    /Liens chiffrés|Destinataire/,
  );
  assert.equal(
    (
      await db.query("select status from signatureflow_documents where id=$1", [
        envelope,
      ])
    ).rows[0].status,
    "draft",
  );
  await db.query("select sf3_issue($1,$2,$3,$4,1,$5,$6)", [
    envelope,
    uid,
    JSON.stringify(links),
    "c".repeat(64),
    JSON.stringify(fields),
    JSON.stringify(links.map((l) => ({ ...l, cipher: "encrypted-only" }))),
  ]);
  assert.equal(
    (await db.query("select count(*)::int n from sf3_jobs")).rows[0].n,
    2,
  );
  await db.exec(
    `set role authenticated;select set_config('request.jwt.claim.sub','${uid}',false)`,
  );
  await assert.rejects(
    db.query("select * from sf3_recipients"),
    /permission denied/,
  );
  await assert.rejects(
    db.query("select sf3_claim_jobs(gen_random_uuid(),5,null)"),
    /permission denied/,
  );
  assert.equal(
    (await db.query("select * from signatureflow_documents")).rows.length,
    0,
    "revoked JDC manager cannot read or edit envelope",
  );
  await db.exec(`select set_config('test.can_manage','yes',false)`);
  assert.equal(
    (await db.query("select * from signatureflow_documents")).rows.length,
    1,
  );
  await assert.rejects(
    db.exec(`update signatureflow_documents set sf3_managed=false`),
    /permission denied/,
  );
  await db.exec("set role service_role");
  const claimed = (
    await db.query("select * from sf3_claim_jobs(gen_random_uuid(),5,null)")
  ).rows;
  assert.equal(claimed.length, 2);
  assert.equal(
    (await db.query("select * from sf3_claim_jobs(gen_random_uuid(),5,null)"))
      .rows.length,
    0,
    "leased job cannot be claimed twice",
  );
  await db.exec(
    `update sf3_jobs set resend_id='email-1' where signer_id='${signer}'`,
  );
  await db.query("select sf3_resend_event($1,$2,$3)", [
    "event-1",
    "email-1",
    "delivered",
  ]);
  await db.query("select sf3_resend_event($1,$2,$3)", [
    "event-1",
    "email-1",
    "bounced",
  ]);
  assert.equal(
    (
      await db.query(
        "select email_status from sf3_recipients where signer_id=$1",
        [signer],
      )
    ).rows[0].email_status,
    "delivered",
    "duplicate webhook cannot change state",
  );
  await assert.rejects(
    db.query("select sf3_record_archive($1,null)", [
      JSON.stringify({
        id: crypto.randomUUID(),
        version_id: v1,
        fingerprint: "stale",
        snapshot: [],
      }),
    ]),
    /évolué/,
  );
  const lease = crypto.randomUUID();
  await db.query("select signatureflow_claim($1,$2,$3,$4)", [
    "d".repeat(64),
    crypto.randomUUID(),
    lease,
    "c".repeat(64),
  ]);
  await db.query("select signatureflow_finish($1,$2,$3,$4,$5,$6,$7,now(),$8)", [
    envelope,
    signer,
    lease,
    "signed.pdf",
    "c".repeat(64),
    "f".repeat(64),
    "Externe",
    "{}",
  ]);
  const queued = (
    await db.query("select kind from sf3_jobs where signer_id=$1", [signer])
  ).rows.map((r) => r.kind);
  assert.ok(
    queued.includes("receipt"),
    "signature creates a durable receipt task",
  );
  assert.ok(
    (await db.query("select kind from sf3_jobs where kind='archive'")).rows
      .length,
    "signature creates a durable archive task",
  );
  const archive = {
    id: crypto.randomUUID(),
    version_id: v1,
    fingerprint: "signed-state",
    snapshot: [{ id: envelope, sha256: "f".repeat(64), status: "in_progress" }],
    storage_bucket: "chantier-documents",
    storage_path: "archive.pdf",
    sha256: "f".repeat(64),
    signed_count: 1,
    expected_count: 2,
    complete: false,
  };
  const metadata = {
    chantier_id: site,
    folder_id: folder,
    owner_id: uid,
    file_name: "ISF-signe.pdf",
    bytes: 100,
    description: "Traçabilité",
  };
  await db.query("select sf3_record_archive($1,$2)", [
    JSON.stringify(archive),
    JSON.stringify(metadata),
  ]);
  await db.query("select sf3_record_archive($1,$2)", [
    JSON.stringify(archive),
    JSON.stringify(metadata),
  ]);
  assert.equal(
    (await db.query("select count(*)::int n from chantier_documents")).rows[0]
      .n,
    1,
    "archive metadata is idempotent",
  );
  await db.query("select sf3_publish_version($1,$2,$3)", [v2, v1, uid]);
  assert.equal(
    (
      await db.query(
        "select token_hash from signatureflow_signers where id=$1",
        [signer2],
      )
    ).rows[0].token_hash,
    null,
  );
  assert.equal(
    (await db.query("select status from signatureflow_documents")).rows[0]
      .status,
    "cancelled",
  );
  await assert.rejects(
    db.query("select sf3_publish_version($1,null,$2)", [v1, uid]),
  );
  assert.equal(
    (
      await db.query("select status from signatureflow_signers where id=$1", [
        signer,
      ])
    ).rows[0].status,
    "signed",
    "publishing a new version preserves prior signatures",
  );
  await db.close();
});
