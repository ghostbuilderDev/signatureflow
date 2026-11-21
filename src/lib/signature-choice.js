import "@fontsource/allura/400.css";
import "@fontsource/dancing-script/400.css";
import "@fontsource/caveat/400.css";

// Fonts are bundled with the app, never fetched from a third-party font service.
export const signatureStyles = [
  { id: "elegant", label: "Élégant", family: "Allura" },
  { id: "fluid", label: "Fluide", family: "Dancing Script" },
  { id: "natural", label: "Naturel", family: "Caveat" },
];

export function initialsFor(name) {
  return name
    .trim()
    .split(/[\s\p{Pd}]+/u)
    .filter(Boolean)
    .map((part) => Array.from(part)[0])
    .join("")
    .toLocaleUpperCase("fr-FR");
}

export async function handwrittenImage(name, style) {
  let timer;
  try {
    const faces = await Promise.race([
      document.fonts.load(`112px "${style.family}"`, name),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Chargement de l’écriture trop long.")),
          8000,
        );
      }),
    ]);
    if (!faces.length || !document.fonts.check(`112px "${style.family}"`, name))
      throw new Error("Écriture indisponible.");
  } finally {
    clearTimeout(timer);
  }
  const canvas = document.createElement("canvas");
  canvas.width = 1200;
  canvas.height = 300;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  let size = 112;
  ctx.font = `${size}px "${style.family}"`;
  let metrics = ctx.measureText(name);
  const width = Math.max(
    metrics.width,
    metrics.actualBoundingBoxLeft + metrics.actualBoundingBoxRight,
  );
  size *= Math.min(
    1,
    1120 / Math.max(width, 1),
    220 /
      Math.max(
        1,
        metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent,
      ),
  );
  ctx.font = `${size}px "${style.family}"`;
  metrics = ctx.measureText(name);
  ctx.fillStyle = "#172b51";
  ctx.fillText(
    name,
    (1200 - metrics.width) / 2,
    (300 + metrics.actualBoundingBoxAscent - metrics.actualBoundingBoxDescent) /
      2,
  );
  // Tight transparent crop keeps even long names legible in the PDF boxes.
  const pixels = ctx.getImageData(0, 0, 1200, 300).data;
  let left = 1200,
    right = -1,
    top = 300,
    bottom = -1;
  for (let y = 0; y < 300; y++)
    for (let x = 0; x < 1200; x++) {
      if (pixels[(y * 1200 + x) * 4 + 3]) {
        left = Math.min(left, x);
        right = Math.max(right, x);
        top = Math.min(top, y);
        bottom = Math.max(bottom, y);
      }
    }
  if (right < left) throw new Error("Impossible de préparer cette signature.");
  const cropped = document.createElement("canvas");
  cropped.width = right - left + 17;
  cropped.height = bottom - top + 17;
  cropped
    .getContext("2d")
    .drawImage(
      canvas,
      left,
      top,
      right - left + 1,
      bottom - top + 1,
      8,
      8,
      right - left + 1,
      bottom - top + 1,
    );
  return cropped.toDataURL("image/png");
}

export function signatureChoiceMarkup(hasInitials) {
  return `<div class="signature-choice stack">
    <fieldset class="signature-method"><legend>Comment souhaitez-vous signer ?</legend>
      <div class="signature-methods">
        <label><input type="radio" name="signatureMode" value="name"> Utiliser mon nom</label>
        <label><input type="radio" name="signatureMode" value="draw"> Dessiner ma signature</label>
      </div>
    </fieldset>
    <div id="nameSignaturePanel" class="stack" hidden>
      <p class="small muted">Choisissez une écriture pour votre nom. Votre choix sera utilisé dans vos zones de signature${hasInitials ? " et pour vos initiales" : ""} de ce document.</p>
      <fieldset class="signature-styles"><legend>Mon style manuscrit</legend><div class="signature-style-grid">
        ${signatureStyles.map((style) => `<label class="signature-style" data-style="${style.id}"><span><input type="radio" name="handwritingStyle" value="${style.id}"> ${style.label}</span><img alt="Aperçu du style ${style.label}" hidden><span class="style-loading">Préparation de l’aperçu…</span></label>`).join("")}
      </div></fieldset>
      ${hasInitials ? '<div class="initials-preview"><span>Mes initiales dans ce style</span><img id="generatedInitials" alt="Aperçu de mes initiales" hidden></div>' : ""}
      <p id="signatureStyleStatus" class="small notice" role="status"></p>
      <button type="button" class="btn secondary fit" id="retrySignatureStyles" hidden>Réessayer les styles</button>
      <label class="check consent"><input id="adoptSignature" type="checkbox" disabled><span>J’adopte cette signature${hasInitials ? " et ces initiales" : ""} pour signer ce document.</span></label>
    </div>
    <div id="drawSignaturePanel" class="stack" hidden>
      <p class="small muted">Tracez votre signature à la souris, au doigt ou au stylet.</p>
      <label>Ma signature<div class="signature-box"><canvas id="signatureCanvas" aria-label="Zone de dessin de la signature"></canvas></div></label>
      <button type="button" class="btn secondary fit" id="clearSignature">Effacer la signature</button>
      ${hasInitials ? '<label>Mes initiales<div class="signature-box"><canvas id="initialsCanvas" aria-label="Zone de dessin des initiales"></canvas></div></label><button type="button" class="btn secondary fit" id="clearInitials">Effacer les initiales</button>' : ""}
    </div>
  </div>`;
}

export function createSignatureChoice({
  root,
  name,
  pad,
  initialPad,
  onChange,
}) {
  const $ = (selector) => root.querySelector(selector);
  const results = new Map();
  let selected = signatureStyles[0].id;
  let mode = matchMedia("(pointer: coarse)").matches ? "draw" : "name";
  let disposed = false;
  let generation = 0;
  const invalidate = () => {
    $("#adoptSignature").checked = false;
    onChange();
  };
  const update = () => {
    $("#nameSignaturePanel").hidden = mode !== "name";
    $("#drawSignaturePanel").hidden = mode !== "draw";
    root.querySelectorAll('[name="signatureMode"]').forEach((radio) => {
      radio.checked = radio.value === mode;
    });
    root.querySelectorAll('[name="handwritingStyle"]').forEach((radio) => {
      radio.checked = radio.value === selected;
    });
    const result = results.get(selected);
    $("#adoptSignature").disabled = !result?.signatureDataUrl;
    $("#signatureStyleStatus").textContent = result?.error
      ? "Cette écriture n’a pas pu être chargée. Réessayez, choisissez un autre style ou dessinez votre signature."
      : result
        ? "Vérifiez l’aperçu, puis cochez « J’adopte cette signature »."
        : "Chargement de l’écriture…";
    $("#retrySignatureStyles").hidden = ![...results.values()].some(
      (r) => r.error,
    );
    if (initialPad) {
      const img = $("#generatedInitials");
      img.hidden = !result?.initialsDataUrl;
      if (result?.initialsDataUrl) img.src = result.initialsDataUrl;
      else img.removeAttribute("src");
    }
  };
  const prepare = async () => {
    const current = ++generation;
    results.clear();
    invalidate();
    update();
    await Promise.all(
      signatureStyles.map(async (style) => {
        const card = root.querySelector(`[data-style="${style.id}"]`);
        card.querySelector("img").hidden = true;
        card.querySelector(".style-loading").textContent =
          "Préparation de l’aperçu…";
        try {
          const signatureDataUrl = await handwrittenImage(name, style);
          const initialsDataUrl = initialPad
            ? await handwrittenImage(initialsFor(name), style)
            : undefined;
          if (disposed || current !== generation) return;
          results.set(style.id, { signatureDataUrl, initialsDataUrl });
          card.querySelector("img").src = signatureDataUrl;
          card.querySelector("img").hidden = false;
          card.querySelector(".style-loading").textContent = "";
        } catch {
          if (disposed || current !== generation) return;
          results.set(style.id, { error: true });
          card.querySelector(".style-loading").textContent =
            "Écriture indisponible";
        }
        update();
      }),
    );
  };
  root.querySelectorAll('[name="signatureMode"]').forEach((radio) => {
    radio.addEventListener("change", () => {
      mode = radio.value;
      invalidate();
      update();
    });
  });
  root.querySelectorAll('[name="handwritingStyle"]').forEach((radio) => {
    radio.addEventListener("change", () => {
      selected = radio.value;
      invalidate();
      update();
    });
  });
  $("#retrySignatureStyles").onclick = prepare;
  pad.addEventListener("beginStroke", onChange);
  initialPad?.addEventListener("beginStroke", onChange);
  $("#clearSignature").onclick = () => {
    pad.clear();
    onChange();
  };
  if (initialPad)
    $("#clearInitials").onclick = () => {
      initialPad.clear();
      onChange();
    };
  update();
  void prepare();
  return {
    getImages() {
      if (mode === "name") {
        const result = results.get(selected);
        if (!result?.signatureDataUrl)
          throw new Error(
            "Attendez le chargement du style, choisissez un autre style ou dessinez votre signature.",
          );
        if (!$("#adoptSignature").checked)
          throw new Error(
            "Vérifiez l’aperçu et cochez « J’adopte cette signature ».",
          );
        return {
          signatureDataUrl: result.signatureDataUrl,
          initialsDataUrl: result.initialsDataUrl,
        };
      }
      if (pad.isEmpty() || (initialPad && initialPad.isEmpty()))
        throw new Error(
          "Tracez votre signature et vos initiales si demandées.",
        );
      return {
        signatureDataUrl: pad.toDataURL("image/png"),
        initialsDataUrl: initialPad?.toDataURL("image/png"),
      };
    },
    destroy() {
      disposed = true;
      generation++;
      pad.removeEventListener("beginStroke", onChange);
      initialPad?.removeEventListener("beginStroke", onChange);
    },
  };
}
