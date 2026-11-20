import { mkdir, copyFile, readdir } from "node:fs/promises";
await mkdir("public/ocr", { recursive: true });
await mkdir("public/pdf-fonts", { recursive: true });
await copyFile(
  "node_modules/tesseract.js/dist/worker.min.js",
  "public/ocr/worker.min.js",
);
for (const file of await readdir("node_modules/tesseract.js-core"))
  if (/\.wasm(\.js)?$/.test(file))
    await copyFile(
      `node_modules/tesseract.js-core/${file}`,
      `public/ocr/${file}`,
    );
for (const lang of ["fra", "eng"])
  await copyFile(
    `node_modules/@tesseract.js-data/${lang}/4.0.0_best_int/${lang}.traineddata.gz`,
    `public/ocr/${lang}.traineddata.gz`,
  );
for (const file of await readdir("node_modules/pdfjs-dist/standard_fonts"))
  await copyFile(
    `node_modules/pdfjs-dist/standard_fonts/${file}`,
    `public/pdf-fonts/${file}`,
  );
console.log(
  "OCR français/anglais et polices PDF prêts (hébergés avec l’application).",
);
