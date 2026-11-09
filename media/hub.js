// @ts-check
(function () {
  // @ts-ignore acquireVsCodeApi is injected by VS Code.
  const vscode = acquireVsCodeApi();
  /** @param {string} id */
  const $ = (id) => /** @type {any} */ (document.getElementById(id));

  /** @type {Record<string,string>} */
  let defaults = {};
  /** @type {any[]} */
  let rows = [];
  /** @type {Set<string>} */
  const selected = new Set();
  let sortKey = "";
  let sortDir = 1;
  let registrationsLoaded = false;
  let currentTag = "";
  let hasMore = false;
  let loadError = "";

  /** @type {Record<string,string>} */
  const BODY_HINTS = {
    apple: "Native APNS JSON payload (aps dictionary).",
    fcmv1: 'FCM v1 JSON payload, wrapped in { "message": { … } }.',
    gcm: "Legacy FCM/GCM JSON payload.",
    "windows-toast": "WNS toast XML.",
    "windows-tile": "WNS tile XML.",
    "windows-badge": "WNS badge XML.",
    "windows-raw": "Raw payload (plain text / octet-stream).",
    template: "JSON object of property values substituted into each device's registered template, e.g. $(message).",
    adm: "Amazon Device Messaging JSON payload.",
    baidu: "Baidu JSON payload.",
    xiaomi: "Xiaomi JSON payload.",
    browser: "Web Push JSON payload.",
  };

  const saved = vscode.getState() || {};

  // ---------- Tabs ----------
  /** @param {string} tab */
  function showTab(tab) {
    document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", /** @type {HTMLElement} */ (b).dataset.tab === tab));
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.toggle("active", p.id === `tab-${tab}`));
    persist({ tab });
    if (tab === "registrations" && !registrationsLoaded) {
      search($("tagSearch").value);
    }
  }
  document.querySelectorAll(".tab").forEach((b) =>
    b.addEventListener("click", () => showTab(/** @type {HTMLElement} */ (b).dataset.tab || "send")),
  );

  /** @param {Record<string, unknown>} patch */
  function persist(patch) {
    Object.assign(saved, patch);
    vscode.setState(saved);
  }

  // ---------- Test send ----------
  function target() {
    const el = /** @type {HTMLInputElement|null} */ (document.querySelector('input[name="target"]:checked'));
    return el ? el.value : "broadcast";
  }

  function updateTargetVisibility() {
    const t = target();
    document.querySelectorAll(".target-tag").forEach((e) => e.classList.toggle("hidden", t !== "tag"));
    document.querySelectorAll(".target-device").forEach((e) => e.classList.toggle("hidden", t !== "device"));
    // Test send isn't supported for direct sends.
    $("testSendWrap").classList.toggle("disabled", t === "device");
    $("testSend").disabled = t === "device";
  }

  function updateBodyHint() {
    $("bodyHint").textContent = BODY_HINTS[$("platform").value] || "";
  }

  let lastPlatform = "";
  $("platform").addEventListener("change", () => {
    const body = $("body");
    if (!body.value.trim() || body.value === defaults[lastPlatform]) {
      body.value = defaults[$("platform").value] || "";
    }
    lastPlatform = $("platform").value;
    updateBodyHint();
    persistForm();
  });
  document.querySelectorAll('input[name="target"]').forEach((r) =>
    r.addEventListener("change", () => {
      updateTargetVisibility();
      persistForm();
    }),
  );
  ["tagExpression", "deviceHandle", "headers", "body"].forEach((id) => $(id).addEventListener("input", persistForm));
  $("testSend").addEventListener("change", persistForm);

  function persistForm() {
    persist({
      form: {
        platform: $("platform").value,
        target: target(),
        tagExpression: $("tagExpression").value,
        deviceHandle: $("deviceHandle").value,
        headers: $("headers").value,
        body: $("body").value,
        testSend: $("testSend").checked,
      },
    });
  }

  $("resetBody").addEventListener("click", () => {
    $("body").value = defaults[$("platform").value] || "";
    persistForm();
  });

  $("sendBtn").addEventListener("click", () => {
    const platform = $("platform").value;
    const body = $("body").value;
    const t = target();
    /** @type {Record<string,string>|undefined} */
    let headers;
    const headersText = $("headers").value.trim();
    if (headersText) {
      try {
        const parsed = JSON.parse(headersText);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Headers must be a JSON object.");
        headers = {};
        for (const [k, v] of Object.entries(parsed)) headers[k] = String(v);
      } catch (e) {
        return showSendError(`Invalid headers: ${e instanceof Error ? e.message : e}`);
      }
    }
    if (!body.trim()) return showSendError("The message payload is empty.");
    if (!platform.startsWith("windows") || platform === "windows-raw") {
      if (body.trim().startsWith("{")) {
        try {
          JSON.parse(body);
        } catch (e) {
          return showSendError(`Payload is not valid JSON: ${e instanceof Error ? e.message : e}`);
        }
      }
    }
    if (t === "tag" && !$("tagExpression").value.trim()) return showSendError("Enter a tag expression.");
    if (t === "device" && !$("deviceHandle").value.trim()) return showSendError("Enter a device handle.");

    $("sendBtn").disabled = true;
    $("sendBtn").textContent = "Sending…";
    vscode.postMessage({
      type: "send",
      request: {
        platform,
        target: t,
        tagExpression: $("tagExpression").value,
        deviceHandle: $("deviceHandle").value,
        body,
        headers,
        testSend: $("testSend").checked,
      },
    });
  });

  /** @param {string} msg */
  function showSendError(msg) {
    prependResult(el("div", { className: "result error" }, [el("strong", {}, "Error: "), msg]));
  }

  /** @param {Node} node */
  function prependResult(node) {
    const container = $("sendResults");
    const placeholder = container.querySelector(".muted");
    if (placeholder) placeholder.remove();
    container.prepend(node);
  }

  /** @param {any} m */
  function renderSendResult(m) {
    $("sendBtn").disabled = false;
    $("sendBtn").textContent = "Send";
    const time = new Date(m.sentAt).toLocaleTimeString();
    if (!m.ok) {
      prependResult(el("div", { className: "result error" }, [el("strong", {}, `${time} — Send failed: `), m.error]));
      return;
    }
    const r = m.response;
    const box = el("div", { className: "result " + (r.failureCount > 0 ? "warn" : "ok") });
    const hasTestResults = m.testSend && r.state === "DetailedStateAvailable";
    const summary = hasTestResults
      ? `${time} — ${r.state}: ${r.successCount} succeeded, ${r.failureCount} failed`
      : `${time} — Notification accepted (${r.state})`;
    box.append(el("strong", {}, summary));
    const meta = el("div", { className: "meta" });
    if (r.notificationId) meta.append(el("span", {}, `Notification ID: ${r.notificationId}`));
    if (r.trackingId) meta.append(el("span", {}, `Tracking ID: ${r.trackingId}`));
    if (r.correlationId) meta.append(el("span", {}, `Correlation ID: ${r.correlationId}`));
    box.append(meta);
    if (hasTestResults) {
      if (r.results.length === 0) {
        box.append(el("p", { className: "muted" }, "No registrations matched the target for this platform."));
      } else {
        const table = el("table", { className: "compact" });
        table.append(el("thead", {}, [el("tr", {}, ["Platform", "Registration ID", "PNS Handle", "Outcome"].map((h) => el("th", {}, h)))]));
        const tbody = el("tbody");
        for (const res of r.results) {
          tbody.append(
            el("tr", {}, [
              el("td", {}, res.applicationPlatform),
              el("td", { className: "mono" }, res.registrationId),
              el("td", { className: "mono ellipsis", title: res.pnsHandle }, res.pnsHandle),
              el("td", { className: /success/i.test(res.outcome) ? "good" : "bad" }, res.outcome),
            ]),
          );
        }
        table.append(tbody);
        box.append(table);
      }
    } else if (m.testSend) {
      box.append(el("p", { className: "muted" }, "Azure accepted the notification but did not return per-device test outcomes. Check notification telemetry in the Azure portal for delivery details."));
    } else {
      box.append(el("p", { className: "muted" }, "Per-device outcomes are only returned for test sends. Check notification telemetry in the Azure portal for delivery details."));
    }
    prependResult(box);
  }

  // ---------- Registrations ----------
  /** @param {string} tag */
  function search(tag) {
    currentTag = tag.trim();
    $("tagSearch").value = currentTag;
    registrationsLoaded = true;
    loadError = "";
    hasMore = false;
    $("loadMore").hidden = true;
    rows = [];
    selected.clear();
    renderRows();
    vscode.postMessage({ type: "loadRegistrations", tag: currentTag });
  }

  $("searchBtn").addEventListener("click", () => search($("tagSearch").value));
  $("tagSearch").addEventListener("keydown", (/** @type {KeyboardEvent} */ e) => {
    if (e.key === "Enter") search($("tagSearch").value);
  });
  $("clearBtn").addEventListener("click", () => search(""));
  $("loadMore").addEventListener("click", () => vscode.postMessage({ type: "loadMore" }));
  $("filterText").addEventListener("input", renderRows);
  $("kindFilter").addEventListener("change", renderRows);
  $("exportBtn").addEventListener("click", () => vscode.postMessage({ type: "export", rows: visibleRows() }));
  $("deleteSelected").addEventListener("click", () => vscode.postMessage({ type: "deleteRegistrations", ids: [...selected] }));
  $("selectAll").addEventListener("change", (/** @type {any} */ e) => {
    for (const r of visibleRows()) {
      if (e.target.checked) selected.add(r.registrationId);
      else selected.delete(r.registrationId);
    }
    renderRows();
  });
  document.querySelectorAll("th[data-sort]").forEach((th) =>
    th.addEventListener("click", () => {
      const key = /** @type {HTMLElement} */ (th).dataset.sort || "";
      sortDir = sortKey === key ? -sortDir : 1;
      sortKey = key;
      renderRows();
    }),
  );

  function visibleRows() {
    const text = $("filterText").value.trim().toLowerCase();
    const kind = $("kindFilter").value;
    let list = rows.filter((r) => {
      if (kind && r.kind !== kind) return false;
      if (!text) return true;
      return [r.registrationId, r.pnsHandle, r.kind, r.templateName || "", ...r.tags].some((v) => String(v).toLowerCase().includes(text));
    });
    if (sortKey) {
      list = [...list].sort((a, b) => {
        const av = sortKey === "tags" ? a.tags.join(",") : a[sortKey] || "";
        const bv = sortKey === "tags" ? b.tags.join(",") : b[sortKey] || "";
        return String(av).localeCompare(String(bv)) * sortDir;
      });
    }
    return list;
  }

  function refreshKindFilter() {
    const select = $("kindFilter");
    const current = select.value;
    const kinds = [...new Set(rows.map((r) => r.kind))].sort();
    select.replaceChildren(el("option", { value: "" }, "All platforms"), ...kinds.map((k) => el("option", { value: k }, k)));
    select.value = kinds.includes(current) ? current : "";
  }

  function renderRows() {
    const tbody = $("regTable").querySelector("tbody");
    const list = visibleRows();
    tbody.replaceChildren(
      ...list.map((r) => {
        const check = el("input", { type: "checkbox", checked: selected.has(r.registrationId) });
        check.addEventListener("change", () => {
          if (check.checked) selected.add(r.registrationId);
          else selected.delete(r.registrationId);
          updateSelectionUi();
        });
        const tagsCell = el("td", { className: "tags" }, r.tags.map((/** @type {string} */ t) => {
          const chip = el("span", { className: "chip", title: `Search registrations with tag "${t}"` }, t);
          chip.addEventListener("click", () => search(t));
          return chip;
        }));
        const kindLabel = r.templateName ? `${r.kind} (${r.templateName})` : r.kind;
        return el("tr", {}, [
          el("td", { className: "col-check" }, [check]),
          el("td", {}, kindLabel),
          el("td", { className: "mono" }, r.registrationId),
          tagsCell,
          el("td", { className: "mono ellipsis", title: r.pnsHandle }, r.pnsHandle),
          el("td", { title: r.expirationTime || "" }, r.expirationTime ? new Date(r.expirationTime).toLocaleDateString() : ""),
          el("td", { className: "col-actions" }, [
            action("Details", "View full registration", () => vscode.postMessage({ type: "showDetails", id: r.registrationId })),
            action("Tags", "Edit tags", () => vscode.postMessage({ type: "editTags", id: r.registrationId, tags: r.tags })),
            action("Send", "Send a test notification to this device", () =>
              vscode.postMessage({ type: "sendToDevice", kind: r.kind, pnsHandle: r.pnsHandle }),
            ),
            action("Copy", "Copy PNS handle", () => navigator.clipboard.writeText(r.pnsHandle)),
            action("Delete", "Delete registration", () => vscode.postMessage({ type: "deleteRegistrations", ids: [r.registrationId] }), "danger"),
          ]),
        ]);
      }),
    );
    if (list.length === 0) {
      tbody.append(el("tr", {}, [el("td", { colSpan: 7, className: "muted center" }, rows.length ? "No rows match the filter." : "No registrations.")]));
    }
    updateSelectionUi();
    updateStatus();
  }

  function updateSelectionUi() {
    const ids = new Set(rows.map((r) => r.registrationId));
    for (const id of [...selected]) if (!ids.has(id)) selected.delete(id);
    $("deleteSelected").disabled = selected.size === 0;
    $("deleteSelected").textContent = selected.size ? `Delete selected (${selected.size})` : "Delete selected";
    const visible = visibleRows();
    $("selectAll").checked = visible.length > 0 && visible.every((r) => selected.has(r.registrationId));
  }

  function updateStatus() {
    if (loadError) {
      $("regStatus").textContent = "Failed to load registrations.";
      return;
    }
    const shown = visibleRows().length;
    const scope = currentTag ? `with tag "${currentTag}"` : "in hub";
    const more = hasMore ? " (more available)" : "";
    $("regStatus").textContent = `${rows.length} registration(s) ${scope} loaded${more}${shown !== rows.length ? `, ${shown} shown` : ""}`;
  }

  /**
   * @param {string} label
   * @param {string} title
   * @param {() => void} onClick
   * @param {string} [extra]
   */
  function action(label, title, onClick, extra) {
    const b = el("button", { className: "link " + (extra || ""), title }, label);
    b.addEventListener("click", onClick);
    return b;
  }

  /**
   * Minimal DOM builder that always uses textContent (never innerHTML).
   * @param {string} tag
   * @param {Record<string, any>} [props]
   * @param {string | Node | (string|Node)[]} [children]
   * @returns {any}
   */
  function el(tag, props = {}, children) {
    const node = document.createElement(tag);
    Object.assign(node, props);
    const list = children === undefined ? [] : Array.isArray(children) ? children : [children];
    for (const c of list) node.append(typeof c === "string" ? document.createTextNode(c) : c);
    return node;
  }

  // ---------- Host messages ----------
  window.addEventListener("message", (event) => {
    const m = event.data;
    switch (m.type) {
      case "init": {
        defaults = m.defaults;
        $("hubTitle").textContent = `${m.hub.namespace} / ${m.hub.hubName}`;
        const select = $("platform");
        select.replaceChildren(...Object.entries(m.platforms).map(([value, label]) => el("option", { value }, /** @type {string} */ (label))));
        const f = saved.form;
        if (f) {
          select.value = f.platform;
          /** @type {any} */ (document.querySelector(`input[name="target"][value="${f.target}"]`) || {}).checked = true;
          $("tagExpression").value = f.tagExpression || "";
          $("deviceHandle").value = f.deviceHandle || "";
          $("headers").value = f.headers || "";
          $("body").value = f.body ?? defaults[f.platform] ?? "";
          $("testSend").checked = f.testSend !== false;
        } else {
          $("body").value = defaults[select.value] || "";
        }
        lastPlatform = select.value;
        updateTargetVisibility();
        updateBodyHint();
        if (saved.tab) showTab(saved.tab);
        break;
      }
      case "showTab":
        showTab(m.tab);
        break;
      case "searchTag":
        showTab("registrations");
        search(m.tag);
        break;
      case "loading":
        $("searchBtn").disabled = m.loading;
        $("loadMore").disabled = m.loading;
        if (m.loading) $("regStatus").textContent = "Loading…";
        else updateStatus();
        break;
      case "registrations":
        loadError = "";
        rows = m.append ? rows.concat(m.rows) : m.rows;
        hasMore = m.hasMore;
        $("loadMore").hidden = !hasMore;
        refreshKindFilter();
        renderRows();
        break;
      case "registrationsError":
        hasMore = false;
        loadError = m.message;
        $("loadMore").hidden = true;
        $("regTable").querySelector("tbody").replaceChildren(el("tr", {}, [el("td", { colSpan: 7, className: "error center" }, m.message)]));
        updateStatus();
        break;
      case "rowUpdated":
        rows = rows.map((r) => (r.registrationId === m.row.registrationId ? m.row : r));
        renderRows();
        break;
      case "rowsDeleted": {
        const ids = new Set(m.ids);
        rows = rows.filter((r) => !ids.has(r.registrationId));
        refreshKindFilter();
        renderRows();
        break;
      }
      case "prefillDevice": {
        showTab("send");
        $("platform").value = m.platform;
        $("platform").dispatchEvent(new Event("change"));
        /** @type {any} */ (document.querySelector('input[name="target"][value="device"]')).checked = true;
        $("deviceHandle").value = m.pnsHandle;
        updateTargetVisibility();
        persistForm();
        $("body").focus();
        break;
      }
      case "sendResult":
        renderSendResult(m);
        break;
    }
  });

  vscode.postMessage({ type: "ready" });
})();
