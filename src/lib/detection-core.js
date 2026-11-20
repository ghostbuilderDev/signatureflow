/** Geometry uses the displayed PDF crop, top-left origin, normalized to [0,1]. */
export const normalize = (s = "") =>
  s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9@._{}-]+/g, " ")
    .trim();
export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
export function bounded(box) {
  const width = clamp(box.width, 0.025, 0.95),
    height = clamp(box.height, 0.018, 0.4);
  return {
    ...box,
    x: clamp(box.x, 0, 1 - width),
    y: clamp(box.y, 0, 1 - height),
    width,
    height,
  };
}
export function overlap(a, b) {
  const area =
    Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) *
    Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  return area / Math.min(a.width * a.height, b.width * b.height);
}
export function deduplicate(fields) {
  const result = [];
  for (const f of [...fields].sort((a, b) => b.confidence - a.confidence)) {
    if (!result.some((g) => g.page === f.page && overlap(g, f) > 0.5))
      result.push(bounded(f));
  }
  return result.sort((a, b) => a.page - b.page || a.y - b.y || a.x - b.x);
}
export function groupLines(tokens) {
  const lines = [];
  for (const token of [...tokens]
    .filter((t) => t.text?.trim())
    .sort((a, b) => a.y - b.y || a.x - b.x)) {
    const line = lines.find(
      (l) =>
        Math.abs(l.y - token.y) < Math.max(l.height, token.height) * 0.55 &&
        token.x >= l.x - 0.01 &&
        token.x <= l.x + l.width + 0.045,
    );
    if (line) {
      line.tokens.push(token);
      line.tokens.sort((a, b) => a.x - b.x);
      line.text = line.tokens.map((t) => t.text).join(" ");
      line.width =
        Math.max(line.x + line.width, token.x + token.width) - line.x;
      line.height = Math.max(line.height, token.height);
    } else lines.push({ ...token, tokens: [token] });
  }
  return lines;
}
export function isLikelyTableOfContents(lines = []) {
  const raw = lines.map((line) => line.text || ""),
    pageText = normalize(raw.join(" ")),
    explicitHeading =
      /\b(sommaire|table des matieres|table of contents|contents|indice du document)\b/.test(
        pageText,
      ),
    numberedEntries = raw.filter(
      (text) =>
        /(?:\.{2,}|·{2,}|_{2,}|\s{4,})\s*\d{1,3}\s*$/.test(text) ||
        /^\s*\d+(?:\.\d+)*\s+.{3,}\s+\d{1,3}\s*$/.test(text),
    ).length,
    headingEntries = raw.filter(
      (text) => /^\s*\d+(?:\.\d+){0,4}\s+\S.{2,}$/.test(text),
    ).length;
  return (
    (explicitHeading && (numberedEntries >= 1 || headingEntries >= 3)) ||
    numberedEntries >= 5
  );
}
function hasIdentityEvidence(text, signers) {
  const value = normalize(text);
  if (
    /\b(nom|prenom|nom et prenom|fonction|qualite|role|responsable|representant|intervenant|agent|entreprise|employeur|client|titulaire)\b/.test(
      value,
    )
  )
    return true;
  return signers.some((signer) => {
    const full = normalize(signer.name),
      role = normalize(signer.role || "");
    if (full.length > 3 && value.includes(full)) return true;
    if (role.length > 3 && value.includes(role)) return true;
    const nameParts = full.split(" ").filter((part) => part.length > 3);
    return nameParts.length >= 2 && nameParts.every((part) => value.includes(part));
  });
}
const signatureWord =
  /\b(signature(?:s)?|signer ici|signez ici|signed by|sign here|firma|unterschrift|handtekening|visa)\b/;
const narrative =
  /\b(signature electronique|signatureflow|docusign|apres signature|avant signature|date de signature|demande de signature|en cas de|doit etre signe|doivent signer|sans signature|pour signature|par sa signature|la signature du present|signature des parties est)\b/;
export function classifyLabel(text) {
  const s = normalize(text).replace(
    /\bs\s*i\s*g\s*n\s*a\s*t\s*u\s*r\s*e\b/g,
    "signature",
  );
  const anchor = s.match(
    /\{\{(signature|initials|name|date|checkbox|text)(?:_([a-z0-9._@-]+))?\}\}/,
  );
  if (anchor)
    return {
      kind: anchor[1],
      confidence: 1,
      anchor: anchor[2] || null,
      reason: "Ancre explicite",
    };
  if (/\b(paraphe|initials)\b/.test(s))
    return { kind: "initials", confidence: 0.9, reason: "Libellé paraphe" };
  if (!signatureWord.test(s) || narrative.test(s) || s.split(" ").length > 16)
    return null;
  return {
    kind: "signature",
    confidence: /\b(signature|sign here|signer ici)\b/.test(s) ? 0.87 : 0.7,
    reason: "Libellé de signature",
  };
}
export function suggestSigner(context, signers) {
  const text = normalize(context);
  const scored = signers
    .map((s) => {
      const name = normalize(s.name),
        role = normalize(s.role || ""),
        email = normalize(s.email || "");
      let score =
        (name.length > 3 && text.includes(name) ? 5 : 0) +
        (email && text.includes(email) ? 8 : 0) +
        (role.length > 2 && text.includes(role) ? 4 : 0);
      if (!score) {
        const parts = name.split(" ").filter((p) => p.length > 3);
        score = parts.filter((p) => new RegExp(`\\b${p}\\b`).test(text)).length;
      }
      return { id: s.id, score };
    })
    .sort((a, b) => b.score - a.score);
  return scored[0]?.score >= 2 && scored[0].score > (scored[1]?.score || 0)
    ? scored[0].id
    : null;
}
export function detectFromLayout({
  page,
  tokens = [],
  widgets = [],
  rules = [],
  cells = [],
  signers = [],
}) {
  const lines = groupLines(tokens),
    tableOfContents = isLikelyTableOfContents(lines),
    candidates = [];
  for (const widget of widgets) {
    const type = classifyLabel(widget.label || "");
    if (widget.signed || !(widget.signature || type)) continue;
    candidates.push({
      ...bounded(widget),
      page,
      kind: type?.kind || "signature",
      confidence: 0.99,
      reason: "Champ PDF natif",
      label: widget.label || "Signature",
      suggested_signer_id: suggestSigner(widget.label, signers),
    });
  }
  for (const line of lines) {
    const type = classifyLabel(line.text);
    if (!type) continue;
    // A mere occurrence in a summary is not a signing field. Explicit anchors and
    // native PDF signature widgets remain authoritative.
    if (tableOfContents && type.reason !== "Ancre explicite") continue;
    const headerCell = cells.find(
      (c) =>
        line.x >= c.x - 0.005 &&
        line.x < c.x + c.width &&
        line.y >= c.y - 0.004 &&
        line.y < c.y + c.height,
    );
    const columnCells = headerCell
      ? cells
          .filter(
            (c) =>
              Math.abs(c.x - headerCell.x) < 0.01 &&
              Math.abs(c.width - headerCell.width) < 0.015 &&
              c.y > headerCell.y + 0.01,
          )
          .sort((a, b) => a.y - b.y)
      : [];
    if (columnCells.length >= 2) {
      for (const cell of columnCells) {
        const inside = lines.filter(
          (l) =>
            l.x >= cell.x + 0.005 &&
            l.x < cell.x + cell.width - 0.005 &&
            l.y >= cell.y &&
            l.y < cell.y + cell.height,
        );
        if (inside.length) continue;
        const rowContext = lines
          .filter((l) => l.y >= cell.y && l.y < cell.y + cell.height)
          .map((l) => l.text)
          .join(" ");
        candidates.push({
          ...bounded({
            x: cell.x + 0.006,
            y: cell.y + 0.006,
            width: cell.width - 0.012,
            height: cell.height - 0.012,
          }),
          page,
          kind: type.kind,
          label: rowContext || line.text,
          confidence: line.source === "ocr" ? 0.78 : 0.92,
          reason:
            "Colonne de signatures + cellule de tableau" +
            (line.source === "ocr" ? " + OCR" : ""),
          suggested_signer_id: suggestSigner(rowContext, signers),
        });
      }
      continue;
    }
    const nearby = lines
      .filter(
        (l) => Math.abs(l.y - line.y) < 0.11 && Math.abs(l.x - line.x) < 0.28,
      )
      .map((l) => l.text)
      .join(" ");
    const rule = rules
      .filter(
        (r) =>
          r.width > 0.1 &&
          r.width < 0.8 &&
          r.y >= line.y - 0.004 &&
          r.y < line.y + 0.17 &&
          r.x <= line.x + 0.12 &&
          r.x + r.width >= line.x + 0.04,
      )
      .sort((a, b) => a.y - b.y)[0];
    const identityEvidence = hasIdentityEvidence(nearby, signers),
      directAction = /\b(signer ici|signez ici|sign here)\b/.test(
        normalize(line.text),
      );
    if (
      type.reason !== "Ancre explicite" &&
      !rule &&
      !identityEvidence &&
      !directAction
    )
      continue;
    const next = lines
      .filter(
        (l) =>
          l.y > line.y + line.height + 0.012 &&
          Math.abs(l.x - line.x) < 0.16 &&
          l.height > 0.005,
      )
      .sort((a, b) => a.y - b.y)[0];
    let box;
    if (rule && rule.y - line.y > 0.035) {
      box = {
        x: rule.x + 0.004,
        y: line.y + line.height + 0.008,
        width: rule.width - 0.008,
        height: Math.min(0.085, rule.y - line.y - line.height - 0.012),
      };
    } else if (rule?.frameHeight > 0.035) {
      box = {
        x: rule.x + 0.006,
        y: rule.y + 0.006,
        width: rule.width - 0.012,
        height: Math.min(0.14, rule.frameHeight - 0.012),
      };
    } else {
      const right = lines
        .filter((l) => l.x > line.x + 0.05 && Math.abs(l.y - line.y) < 0.02)
        .sort((a, b) => a.x - b.x)[0];
      const height = clamp(
        (next?.y || line.y + 0.105) - line.y - line.height - 0.014,
        0.025,
        0.085,
      );
      box = {
        x: line.x,
        y: line.y + line.height + 0.008,
        width: Math.min(0.29, (right?.x || 1) - line.x - 0.015),
        height,
      };
    }
    let confidence =
      type.confidence +
      (rule?.frameHeight?.valueOf() > 0
        ? 0.07
        : rule?.width?.valueOf() > 0
          ? 0.04
          : -0.04);
    if (identityEvidence) confidence += 0.07;
    if (directAction) confidence += 0.05;
    if (line.source === "ocr") confidence -= 0.1;
    if (box.height < 0.03) confidence -= 0.12;
    candidates.push({
      ...bounded(box),
      page,
      kind: type.kind,
      label: line.text.slice(0, 160),
      confidence: clamp(confidence, 0.35, 0.99),
      reason:
        type.reason +
        (rule ? " + cadre/ligne" : "") +
        (line.source === "ocr" ? " + OCR" : ""),
      suggested_signer_id: suggestSigner(
        `${type.anchor || ""} ${nearby}`,
        signers,
      ),
    });
  }
  return deduplicate(candidates);
}
/** Bounded raster scan detects long horizontal rules and pairs them into frames. */
export function detectRules({ data, width, height }) {
  const rows = [],
    dark = (x, y) => {
      const i = (y * width + x) * 4;
      return data[i] + data[i + 1] + data[i + 2] < 460 && data[i + 3] > 100;
    };
  for (let y = 0; y < height; y++) {
    let start = -1,
      gap = 0;
    for (let x = 0; x <= width + 3; x++) {
      if (x < width && dark(x, y)) {
        if (start < 0) start = x;
        gap = 0;
      } else if (start >= 0 && ++gap > 3) {
        const end = x - gap + 1;
        if (end - start > width * 0.09)
          rows.push({
            x: start / width,
            y: y / height,
            width: (end - start) / width,
            height: 1 / height,
          });
        start = -1;
        gap = 0;
      }
    }
  }
  const rules = rows.filter(
    (r, i) =>
      !rows
        .slice(Math.max(0, i - 10), i)
        .some(
          (p) =>
            Math.abs(p.y - r.y) < 0.004 &&
            Math.abs(p.x - r.x) < 0.005 &&
            Math.abs(p.width - r.width) < 0.01,
        ),
  );
  return rules.map((r) => {
    const bottom = rules.find(
      (b) =>
        b.y > r.y + 0.035 &&
        b.y < r.y + 0.2 &&
        Math.abs(b.x - r.x) < 0.008 &&
        Math.abs(b.width - r.width) < 0.012,
    );
    if (bottom) {
      let hits = 0,
        total = 0;
      for (let y = Math.round(r.y * height); y < bottom.y * height; y += 3) {
        total++;
        if (
          dark(Math.round(r.x * width), y) ||
          dark(Math.round((r.x + r.width) * width) - 1, y)
        )
          hits++;
      }
      if (hits / total > 0.65) return { ...r, frameHeight: bottom.y - r.y };
    }
    return r;
  });
}
/** Finds bounded table cells from horizontal and vertical raster rules. */
export function detectTableCells({ data, width, height }, rules) {
  const dark = (x, y) => {
    const i = (y * width + x) * 4;
    return data[i] + data[i + 1] + data[i + 2] < 460 && data[i + 3] > 100;
  };
  const vertical = [];
  for (let x = 0; x < width; x++) {
    let start = -1,
      gap = 0;
    for (let y = 0; y <= height + 3; y++) {
      if (y < height && dark(x, y)) {
        if (start < 0) start = y;
        gap = 0;
      } else if (start >= 0 && ++gap > 3) {
        const end = y - gap + 1;
        if (end - start > height * 0.025)
          vertical.push({ x: x / width, y: start / height, end: end / height });
        start = -1;
        gap = 0;
      }
    }
  }
  const cells = [];
  for (const top of rules) {
    const bottom = rules
      .filter(
        (b) =>
          b.y > top.y + 0.023 &&
          b.y < top.y + 0.23 &&
          Math.abs(b.x - top.x) < 0.01 &&
          Math.abs(b.width - top.width) < 0.015,
      )
      .sort((a, b) => a.y - b.y)[0];
    if (!bottom) continue;
    const xs = [];
    for (const v of vertical
      .filter(
        (v) =>
          v.y <= top.y + 0.006 &&
          v.end >= bottom.y - 0.006 &&
          v.x >= top.x - 0.006 &&
          v.x <= top.x + top.width + 0.006,
      )
      .sort((a, b) => a.x - b.x))
      if (!xs.some((x) => Math.abs(x - v.x) < 0.006)) xs.push(v.x);
    for (let i = 0; i < xs.length - 1; i++) {
      const w = xs[i + 1] - xs[i];
      if (w > 0.07 && w < 0.85)
        cells.push({ x: xs[i], y: top.y, width: w, height: bottom.y - top.y });
    }
  }
  return cells;
}
