import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
const target = process.argv[2];
if (!target) throw new Error("Dossier de migrations cible requis");
const remote = await readdir(target);
for (const name of (await readdir("supabase/migrations"))
  .filter((n) => /^\d{14}_signatureflow.*\.sql$/.test(n))
  .sort()) {
  const version = name.split("_")[0];
  if (remote.some((file) => file.startsWith(version + "_"))) {
    console.log(`Migration ${version} déjà enregistrée, conservée.`);
    continue;
  }
  await writeFile(
    join(target, name),
    await readFile(join("supabase/migrations", name)),
    { flag: "wx" },
  );
  console.log(`Migration SignatureFlow préparée : ${version}`);
}
