export function normalizeRecipients(rows) {
  if (!Array.isArray(rows) || !rows.length || rows.length > 1000)
    throw new Error("Choisissez entre 1 et 1000 destinataires.");
  const seen = new Set();
  return rows.map((r) => {
    const email = String(r.email || "")
        .trim()
        .toLowerCase(),
      name = String(r.name || "").trim(),
      role = String(r.role || "").trim(),
      company = String(r.company || "").trim();
    if (
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
      email.length > 254 ||
      !name ||
      name.length > 160 ||
      !role ||
      role.length > 100 ||
      company.length > 160 ||
      seen.has(email)
    )
      throw new Error(
        "Chaque destinataire doit avoir un nom, une fonction et une adresse distincte valides.",
      );
    seen.add(email);
    return { email, name, role, company };
  });
}
export function batches(rows, n = 40) {
  return Array.from({ length: Math.ceil(rows.length / n) }, (_, i) =>
    rows.slice(i * n, (i + 1) * n),
  );
}
export function validUUID(value) {
  return (
    typeof value === "string" &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
      value,
    )
  );
}
export function safeTitle(value, max = 200) {
  const s = String(value || "")
    .replace(/[\x00-\x1f]/g, " ")
    .trim();
  if (!s || s.length > max) throw new Error("Libellé absent ou trop long.");
  return s;
}
export const fileSlug = (s) =>
  String(s)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .slice(0, 140);
const latin = (s) =>
  String(s || "").replace(
    /[^\x20-\xff\u2013\u2014\u2018\u2019\u201c\u201d\u2022\u20ac]/g,
    "?",
  );
export async function buildEnvelope(source, signers, options, lib) {
  const original = await lib.PDFDocument.load(source),
    pdf = await lib.PDFDocument.create();
  if (original.getPageCount() > 190)
    throw new Error("190 pages maximum pour conserver la place des annexes.");
  const copied = await pdf.copyPages(original, original.getPageIndices());
  copied.forEach((p) => pdf.addPage(p));
  const annexStart = pdf.getPageCount(),
    fields = [],
    font = await pdf.embedFont(lib.StandardFonts.Helvetica),
    bold = await pdf.embedFont(lib.StandardFonts.HelveticaBold);
  if (options.mode === "acknowledgement") {
    for (let i = 0; i < signers.length; i += 5) {
      const page = pdf.addPage([595.28, 841.89]);
      const text = (s, x, y, size = 10, heavy = false) => {
        const selected = heavy ? bold : font;
        let value = latin(s);
        if (selected.widthOfTextAtSize(value, size) > 515) {
          while (
            value.length &&
            selected.widthOfTextAtSize(value + "...", size) > 515
          )
            value = value.slice(0, -1);
          value += "...";
        }
        page.drawText(value, { x, y, size, font: selected });
      };
      text("ANNEXE DE PRISE DE CONNAISSANCE", 40, 800, 16, true);
      text(`${options.title} - indice ${options.label}`, 40, 773, 11, true);
      text(
        "Document original conserve sans modification. Cette annexe identifie sa version.",
        40,
        751,
        9,
      );
      text(`SHA-256 original : ${options.sha256}`, 40, 731, 8);
      for (let j = i; j < Math.min(i + 5, signers.length); j++) {
        const s = signers[j],
          y = 690 - (j - i) * 125;
        text(s.name, 40, y, 11, true);
        text(
          `${s.company || "Entreprise non precisee"} - ${s.role}`,
          40,
          y - 19,
          9,
        );
        page.drawRectangle({
          x: 40,
          y: y - 98,
          width: 515,
          height: 67,
          borderWidth: 0.5,
          borderColor: lib.rgb(0.65, 0.7, 0.77),
        });
        fields.push({
          id: crypto.randomUUID(),
          signer_id: s.id,
          page: pdf.getPageCount(),
          x: 40 / 595.28,
          y: (841.89 - (y - 31)) / 841.89,
          width: 515 / 595.28,
          height: 67 / 841.89,
          kind: "signature",
          label: "Prise de connaissance",
        });
      }
      text(
        `Campagne ${options.campaignId} - annexe ${pdf.getPageCount() - annexStart}`,
        40,
        25,
        8,
      );
    }
  }
  return {
    bytes: await pdf.save(),
    pages: pdf.getPageCount(),
    annexStart,
    fields,
  };
}
