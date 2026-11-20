import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
const target = process.argv[2];
if (!target) throw new Error("Dossier de migrations cible requis");
const remote = await readdir(target);
for (const name of [
  "20260918182400_signatureflow.sql",
  "20261120023410_signatureflow_v2.sql",
]) {
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
