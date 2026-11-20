export function validateFields(fields, pages, signers) {
  if (!fields.length || fields.length > 500)
    throw new Error("Configurez entre 1 et 500 zones.");
  for (const f of fields) {
    const vals = ["x", "y", "width", "height"].map((k) => Number(f[k]));
    if (
      vals.some((v) => !Number.isFinite(v)) ||
      vals[0] < 0 ||
      vals[1] < 0 ||
      vals[2] <= 0 ||
      vals[3] <= 0 ||
      vals[0] + vals[2] > 1.00001 ||
      vals[1] + vals[3] > 1.00001
    )
      throw new Error("Zone hors page");
    if (!Number.isInteger(f.page) || f.page < 1 || f.page > pages)
      throw new Error("Page inexistante");
    if (!signers.some((s) => s.id === f.signer_id))
      throw new Error("Signataire incohérent");
  }
  for (const s of signers)
    if (
      !fields.some(
        (f) =>
          f.signer_id === s.id && ["signature", "initials"].includes(f.kind),
      )
    )
      throw new Error(`Ajoutez une signature ou un paraphe pour ${s.name}.`);
}
/** Inverse PDF.js viewport at unit scale: supports CropBox offsets and all page rotations. */
export function placement(page, field) {
  const crop = page.getCropBox(),
    r = ((page.getRotation().angle % 360) + 360) % 360;
  const w = r % 180 ? crop.height : crop.width,
    h = r % 180 ? crop.width : crop.height;
  const x = Number(field.x) * w,
    y = Number(field.y) * h,
    fw = Number(field.width) * w,
    fh = Number(field.height) * h;
  let origin;
  if (r === 0) origin = [crop.x + x, crop.y + crop.height - y - fh];
  else if (r === 90) origin = [crop.x + y + fh, crop.y + x];
  else if (r === 180) origin = [crop.x + crop.width - x, crop.y + y + fh];
  else if (r === 270)
    origin = [crop.x + crop.width - y - fh, crop.y + crop.height - x];
  else throw new Error("Rotation PDF non prise en charge");
  return { x: origin[0], y: origin[1], width: fw, height: fh, rotation: r };
}
const safe = (v) =>
  String(v)
    .replace(/[\r\n\t]/g, " ")
    .split("")
    .map((c) => (c.charCodeAt(0) > 255 ? "?" : c))
    .join("");
function fitted(font, text, maxWidth, maxSize) {
  let size = maxSize;
  while (font.widthOfTextAtSize(text, size) > maxWidth && size > 3)
    size -= 0.25;
  return size;
}
export async function stampPdf(
  pdf,
  fields,
  { signature, initials, typedName, signedAt, values = {}, email },
  lib,
) {
  const font = await pdf.embedFont(lib.StandardFonts.Helvetica);
  const image = await pdf.embedPng(signature),
    initialImage = initials ? await pdf.embedPng(initials) : null;
  for (const f of fields) {
    const p = pdf.getPage(f.page - 1),
      b = placement(p, f),
      pad = 2;
    const origin = (x, y) => {
      const a = (b.rotation * Math.PI) / 180;
      return {
        x: b.x + x * Math.cos(a) - y * Math.sin(a),
        y: b.y + x * Math.sin(a) + y * Math.cos(a),
      };
    };
    const text = (value, y, maxSize = 10) => {
      const valueSafe = safe(value),
        size = fitted(
          font,
          valueSafe,
          b.width - 4,
          Math.min(maxSize, b.height * 0.65),
        );
      p.drawText(valueSafe, {
        ...origin(pad, y),
        font,
        size,
        rotate: lib.degrees(b.rotation),
        color: lib.rgb(0.09, 0.14, 0.2),
      });
    };
    if (f.kind === "signature" || f.kind === "initials") {
      const img = f.kind === "initials" ? initialImage : image;
      if (!img) throw new Error("Paraphe obligatoire");
      const availableH = Math.max(4, b.height - 13),
        scale = Math.min((b.width - 4) / img.width, availableH / img.height);
      p.drawImage(img, {
        ...origin(pad + (b.width - 4 - img.width * scale) / 2, 12),
        width: img.width * scale,
        height: img.height * scale,
        rotate: lib.degrees(b.rotation),
      });
      text(
        `${typedName} - ${signedAt.toLocaleString("fr-FR", { timeZone: "Europe/Paris", dateStyle: "short", timeStyle: "short" })}`,
        2,
        6,
      );
    } else if (f.kind === "name") text(typedName, pad);
    else if (f.kind === "date")
      text(
        signedAt.toLocaleDateString("fr-FR", { timeZone: "Europe/Paris" }),
        pad,
      );
    else if (f.kind === "checkbox") {
      if (values[f.id] === true) text("X", pad, 14);
      else if (f.required) throw new Error("Case obligatoire non cochée");
    } else if (f.kind === "text") {
      const v = values[f.id];
      if (f.required && !(typeof v === "string" && v.trim()))
        throw new Error("Champ obligatoire vide");
      text(String(v || "").slice(0, 500), pad);
    }
  }
  pdf.setModificationDate(signedAt);
  return new Uint8Array(await pdf.save());
}
export function pngBytes(url) {
  if (
    typeof url !== "string" ||
    url.length > 900_000 ||
    !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(url)
  )
    throw new Error("Image de signature PNG invalide");
  const raw = atob(url.split(",")[1]),
    bytes = Uint8Array.from(raw, (c) => c.charCodeAt(0));
  if (
    bytes.length < 100 ||
    bytes[0] !== 137 ||
    bytes[1] !== 80 ||
    bytes[2] !== 78 ||
    bytes[3] !== 71
  )
    throw new Error("Signature PNG invalide");
  const view = new DataView(bytes.buffer);
  if (view.getUint32(16) > 4000 || view.getUint32(20) > 2000)
    throw new Error("Image trop grande");
  return bytes;
}
