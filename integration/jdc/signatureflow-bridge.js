/* SignatureFlow 3: uses the existing JDC client, never stores invitation tokens. */
(function (root) {
  "use strict";
  function create(config) {
    let dialog,
      ui,
      badge,
      notice,
      actor = "",
      lastPopup = "",
      checking = false,
      disposed = false;
    const st = () => config.getState();
    const makeUI = () =>
      root.SignatureFlowDocumentUI.create({ ...config, onClose: close });
    function close() {
      ui?.destroy();
      dialog?.close();
      dialog?.remove();
      dialog = null;
      ui = null;
    }
    function open(opts = {}) {
      if (!st().user || !st().cloud) return;
      close();
      dialog = document.createElement("dialog");
      dialog.className = "sf3-dialog";
      const host = document.createElement("section");
      dialog.append(host);
      document.body.append(dialog);
      dialog.addEventListener("cancel", () => close());
      dialog.showModal();
      ui = makeUI();
      void ui.mount(host, opts);
    }
    function updateButtons() {
      const s = st();
      if ((s.user?.id || "") !== actor) {
        actor = s.user?.id || "";
        lastPopup = "";
        close();
        removeInbox();
      }
      const header = document.querySelector(".documentation-header");
      let trigger = header?.querySelector("[data-sf3-documents]");
      if (header && !trigger) {
        trigger = document.createElement("button");
        trigger.type = "button";
        trigger.dataset.sf3Documents = "";
        trigger.textContent = "Signatures et prises de connaissance";
        trigger.className = "sf3-inline-action";
        trigger.onclick = () => open();
        header.append(trigger);
      }
      if (trigger) trigger.hidden = !s.cloud || !s.user || !s.chantierId;
      document.querySelectorAll(".document-file-card").forEach((card) => {
        const id = card.querySelector("[data-document-id]")?.dataset.documentId;
        if (
          !id ||
          !s.canManage ||
          !s.cloud ||
          !s.documents?.some(
            (d) =>
              d.id === id &&
              (/\.pdf$/i.test(d.file_name) ||
                d.mime_type === "application/pdf"),
          )
        )
          return;
        if (!card.querySelector("[data-sf3-source]")) {
          const b = document.createElement("button");
          b.type = "button";
          b.className = "sf3-inline-action";
          b.dataset.sf3Source = id;
          b.textContent = "Faire signer / suivre";
          b.onclick = (e) => {
            e.stopPropagation();
            open({ sourceDocumentId: id });
          };
          card.append(b);
        }
      });
      if (!s.canManage || !s.cloud)
        document
          .querySelectorAll("[data-sf3-source]")
          .forEach((b) => b.remove());
    }
    function removeInbox() {
      badge?.remove();
      badge = null;
      notice?.remove();
      notice = null;
    }
    async function checkInbox() {
      updateButtons();
      const s = st();
      if ((s.user?.id || "") !== actor) {
        actor = s.user?.id || "";
        lastPopup = "";
        close();
        removeInbox();
      }
      if (
        !actor ||
        !s.cloud ||
        document.hidden ||
        !navigator.onLine ||
        checking ||
        disposed
      )
        return;
      checking = true;
      const expected = actor;
      try {
        const reader = makeUI(),
          result = await reader.api("inbox");
        reader.destroy();
        if (disposed || st().user?.id !== expected) return;
        if (!result.items.length) {
          removeInbox();
          return;
        }
        if (!badge) {
          badge = document.createElement("button");
          badge.type = "button";
          badge.className = "sf3-inbox-trigger";
          badge.onclick = () => open({ inbox: true });
          document.body.append(badge);
        }
        badge.textContent = `${result.items.length} document(s) à consulter et signer`;
        const key = result.items
          .map((i) => i.id)
          .sort()
          .join(",");
        const editing =
          document.querySelector("dialog[open]") ||
          document.activeElement?.matches(
            "input,textarea,[contenteditable=true]",
          );
        if (!editing && key !== lastPopup) {
          lastPopup = key;
          const seenKey = "sf3-notice:" + actor + ":" + key;
          if (sessionStorage.getItem(seenKey)) return;
          sessionStorage.setItem(seenKey, "1");
          notice = document.createElement("div");
          notice.className = "sf3-inbox-notice";
          notice.setAttribute("role", "status");
          const p = document.createElement("p");
          p.textContent =
            "Vous avez des documents à prendre en connaissance ou à signer.";
          const view = document.createElement("button");
          view.type = "button";
          view.textContent = "Consulter mes demandes";
          view.onclick = () => {
            notice?.remove();
            open({ inbox: true });
          };
          const later = document.createElement("button");
          later.type = "button";
          later.textContent = "Plus tard";
          later.onclick = () => notice?.remove();
          notice.append(p, view, later);
          document.body.append(notice);
        }
      } catch {
        /* JDC remains usable before the backend module is activated. */
      } finally {
        checking = false;
      }
    }
    let scheduled = false;
    const observer = new MutationObserver(() => {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        updateButtons();
      });
    });
    observer.observe(document.body, { childList: true, subtree: true });
    const timer = setInterval(checkInbox, 30000);
    const visibility = () => {
      if (!document.hidden) void checkInbox();
    };
    document.addEventListener("visibilitychange", visibility);
    root.addEventListener("online", visibility);
    void checkInbox();
    return {
      open,
      refresh: checkInbox,
      destroy() {
        disposed = true;
        clearInterval(timer);
        observer.disconnect();
        document.removeEventListener("visibilitychange", visibility);
        root.removeEventListener("online", visibility);
        close();
        removeInbox();
        document
          .querySelectorAll("[data-sf3-source],[data-sf3-documents]")
          .forEach((b) => b.remove());
      },
    };
  }
  root.JournalSignatureFlow = { create };
})(window);
