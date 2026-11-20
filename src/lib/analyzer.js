import { Util } from "pdfjs-dist";
import {
  detectFromLayout,
  detectRules,
  detectTableCells,
  deduplicate,
} from "./detection-core.js";
export async function analyzePdf(
  pdf,
  signers,
  { ocrMode = "auto", onProgress = () => {}, signal } = {},
) {
  const candidates = [],
    warnings = [];
  let worker,
    ocrPages = 0;
  const check = () => {
    if (signal?.aborted)
      throw new DOMException("Analyse annulée", "AbortError");
  };
  try {
    for (let p = 1; p <= pdf.numPages; p++) {
      check();
      onProgress(`Analyse de la page ${p}/${pdf.numPages}`);
      const page = await pdf.getPage(p),
        view = page.getViewport({ scale: 1 });
      const text = await page.getTextContent();
      let tokens = text.items
        .filter((i) => i.str?.trim())
        .map((i) => {
          const t = Util.transform(view.transform, i.transform),
            h = Math.hypot(t[2], t[3]);
          return {
            text: i.str,
            x: t[4] / view.width,
            y: (t[5] - h) / view.height,
            width: i.width / view.width,
            height: h / view.height,
            source: "text",
          };
        });
      const annotations = await page.getAnnotations();
      const widgets = annotations
        .filter((a) => a.subtype === "Widget")
        .map((a) => {
          const [x1, y1, x2, y2] = view.convertToViewportRectangle(a.rect);
          return {
            x: Math.min(x1, x2) / view.width,
            y: Math.min(y1, y2) / view.height,
            width: Math.abs(x2 - x1) / view.width,
            height: Math.abs(y2 - y1) / view.height,
            label: a.alternativeText || a.fieldName,
            signature: a.fieldType === "Sig",
            signed: a.fieldType === "Sig" && !!a.fieldValue,
          };
        });
      if (annotations.some((a) => a.fieldType === "Sig" && a.fieldValue))
        warnings.push(
          `Page ${p} : signature numérique existante. Une réécriture du PDF peut l’invalider ; utilisez un original non signé.`,
        );
      const scale = Math.min(2, 1600 / Math.max(view.width, view.height)),
        vp = page.getViewport({ scale });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(vp.width);
      canvas.height = Math.ceil(vp.height);
      const context = canvas.getContext("2d", { willReadFrequently: true });
      await page.render({ canvasContext: context, viewport: vp }).promise;
      check();
      const raster = context.getImageData(0, 0, canvas.width, canvas.height);
      const rules = detectRules(raster),
        cells = detectTableCells(raster, rules);
      if (
        ocrMode === "always" ||
        (ocrMode === "auto" && tokens.map((t) => t.text).join("").length < 80)
      ) {
        onProgress(`Lecture OCR de la page ${p}/${pdf.numPages}…`);
        try {
          if (!worker) {
            const { createWorker } = await import("tesseract.js");
            const base = new URL(
              `${import.meta.env.BASE_URL}ocr/`,
              location.href,
            ).href;
            worker = await createWorker("fra+eng", 1, {
              workerPath: base + "worker.min.js",
              corePath: base,
              langPath: base,
              workerBlobURL: false,
              logger: (m) => {
                if (m.status === "recognizing text")
                  onProgress(
                    `OCR page ${p} · ${Math.round(m.progress * 100)} %`,
                  );
              },
            });
          }
          const { data } = await worker.recognize(
            canvas,
            {},
            { blocks: true, text: true },
          );
          check();
          const words = (data.blocks || [])
            .flatMap((b) => b.paragraphs || [])
            .flatMap((b) => b.lines || [])
            .flatMap((b) => b.words || []);
          const ocr = words
            .filter((w) => w.confidence >= 38)
            .map((w) => ({
              text: w.text,
              x: w.bbox.x0 / canvas.width,
              y: w.bbox.y0 / canvas.height,
              width: (w.bbox.x1 - w.bbox.x0) / canvas.width,
              height: (w.bbox.y1 - w.bbox.y0) / canvas.height,
              source: "ocr",
            }));
          if (ocrMode === "always") tokens = ocr;
          else tokens = [...tokens, ...ocr];
          ocrPages++;
          if (!ocr.length)
            warnings.push(
              `Page ${p} : OCR sans texte exploitable. Placez les zones manuellement.`,
            );
        } catch (e) {
          if (e.name === "AbortError") throw e;
          warnings.push(
            `Page ${p} : OCR indisponible (${e.message}). Placement manuel possible.`,
          );
        }
      }
      candidates.push(
        ...detectFromLayout({
          page: p,
          tokens,
          widgets,
          rules,
          cells,
          signers,
        }),
      );
      canvas.width = canvas.height = 1;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    return {
      candidates: deduplicate(candidates),
      warnings,
      ocrPages,
      pages: pdf.numPages,
    };
  } finally {
    await worker?.terminate();
  }
}
