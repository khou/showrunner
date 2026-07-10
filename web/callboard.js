// Callboard: single-file, no build step. Polls GET /api/shows/:show/state every 2s and renders
// director/members/tasks/notes/activity/escalations. A window, not a control panel (DESIGN.md):
// no task forms, no message box, no admin actions -- those live in the CLI against the same
// /api the poll here reads. Steer the show by talking to the director agent in its own chat,
// which the chat link below opens.
(function () {
  "use strict";

  const TOKEN_KEY = "showrunner_token";
  const SHOW_KEY = "showrunner_show";
  const POLL_MS = 2000;
  const NOTE_BODY_TRIM = 140;

  const state = {
    token: localStorage.getItem(TOKEN_KEY) || "",
    show: localStorage.getItem(SHOW_KEY) || "",
    expanded: new Set(), // task ids with journal expanded
    pollTimer: null,
  };

  const el = (id) => document.getElementById(id);
  const showSelect = el("show-select");
  const showEmptyHint = el("show-empty-hint");
  const tokenInput = el("token-input");
  const tokenStatus = el("token-status");
  const lastPoll = el("last-poll");
  const banner = el("banner");

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function relTime(ms) {
    const diff = Date.now() - ms;
    const s = Math.round(diff / 1000);
    if (s < 5) return "just now";
    if (s < 60) return `${s}s ago`;
    const m = Math.round(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.round(m / 60);
    if (h < 48) return `${h}h ago`;
    return `${Math.round(h / 24)}d ago`;
  }

  async function api(path, opts) {
    const res = await fetch(path, {
      ...opts,
      headers: { ...(opts && opts.headers), Authorization: `Bearer ${state.token}` },
    });
    if (res.status === 401) {
      tokenStatus.textContent = "invalid token";
      tokenStatus.style.color = "var(--red)";
      throw new Error("unauthorized");
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `http ${res.status}`);
    return body;
  }

  function saveToken(value) {
    state.token = value;
    localStorage.setItem(TOKEN_KEY, value);
    tokenStatus.textContent = value ? "saved" : "";
    tokenStatus.style.color = "var(--dim)";
  }

  // --- shows ---

  async function loadShows() {
    if (!state.token) return;
    let data;
    try {
      data = await api("/api/shows");
    } catch {
      return;
    }
    const shows = data.shows || [];
    showEmptyHint.hidden = shows.length > 0;
    const prev = showSelect.value || state.show;
    showSelect.innerHTML = shows.length
      ? shows.map((s) => `<option value="${escapeHtml(s.name)}">${escapeHtml(s.name)}</option>`).join("")
      : '<option value="">(no shows yet)</option>';
    const pick = shows.find((s) => s.name === prev) ? prev : shows[0] ? shows[0].name : "";
    showSelect.value = pick;
    if (pick !== state.show) selectShow(pick);
  }

  function selectShow(show) {
    state.show = show;
    localStorage.setItem(SHOW_KEY, show);
    state.expanded.clear();
    stopPolling();
    if (show) startPolling();
    else render(null);
  }

  // --- polling ---

  function startPolling() {
    fetchState();
    state.pollTimer = setInterval(fetchState, POLL_MS);
  }

  function stopPolling() {
    if (state.pollTimer) clearInterval(state.pollTimer);
    state.pollTimer = null;
  }

  async function fetchState() {
    if (!state.token || !state.show) return;
    try {
      const data = await api(`/api/shows/${encodeURIComponent(state.show)}/state`);
      render(data);
      lastPoll.textContent = `updated ${relTime(Date.now())}`;
    } catch (err) {
      lastPoll.textContent = `poll failed: ${err.message}`;
    }
  }

  // --- rendering ---

  function render(board) {
    renderDirector(board && board.director);
    renderMembers(board ? board.members : []);
    renderTasks(board ? board.tasks : []);
    renderNotes(board);
    renderActivity(board);
    renderBanner(board && board.escalations);
  }

  // Director card / member row chat link (DESIGN.md "the chat link"): session_url renders as a
  // prominent "open chat" anchor, resume_hint (no session_url) as click-to-copy code, neither as
  // a dim hint the session didn't report one.
  function chatLinkHtml(entity) {
    if (entity.sessionUrl) {
      return `<a class="chat-open" href="${escapeHtml(entity.sessionUrl)}" target="_blank" rel="noopener">open chat &#8599;</a>`;
    }
    if (entity.resumeHint) {
      // resume_hint is self-reported by the session, not vetted by the server (DESIGN.md security
      // posture: one shared token, no per-member trust) -- label it so a copy-paste isn't mistaken
      // for a server-verified command.
      return `<code class="resume-hint">${escapeHtml(entity.resumeHint)}</code> <button type="button" class="copy-hint" data-hint="${escapeHtml(entity.resumeHint)}">copy</button> <span class="hint" title="self-reported by the session, not verified by the server">self-reported</span>`;
    }
    return `<span class="hint">no chat link reported</span>`;
  }

  function renderDirector(director) {
    const body = el("director-body");
    if (!state.show) {
      body.textContent = "no show selected";
      return;
    }
    if (!director) {
      body.innerHTML = `<span class="hint">no director -- show is headless</span>`;
      return;
    }
    const dot = director.stale ? "stale" : "fresh";
    body.innerHTML = `
      <div><span class="dot ${dot}"></span> ${escapeHtml(director.memberId)}</div>
      <div class="hint">epoch ${director.epoch} &middot; ${director.stale ? "lease expired" : "lease active"}</div>
      <div class="chat-link">${chatLinkHtml(director)}</div>
    `;
  }

  function renderMembers(members) {
    const list = el("members-list");
    if (!state.show) {
      list.innerHTML = `<li class="hint">no show selected</li>`;
      return;
    }
    if (!members.length) {
      list.innerHTML = `<li class="hint">no members registered yet</li>`;
      return;
    }
    list.innerHTML = members
      .map((m) => {
        const dot = m.stale ? "stale" : "fresh";
        const name = escapeHtml(m.displayName || m.id);
        const chat = m.sessionUrl
          ? ` <a class="chat-open-small" href="${escapeHtml(m.sessionUrl)}" target="_blank" rel="noopener" title="open chat">&#8599;</a>`
          : "";
        return `<li>
          <span class="dot ${dot}"></span>
          <span>${name}${chat}</span>
          <span class="badge">${escapeHtml(m.kind)}</span>
          <span class="badge">${escapeHtml(m.role)}</span>
          <span class="hint">${m.currentTaskId ? `on ${escapeHtml(m.currentTaskId)}` : "idle"}</span>
          <span class="hint" style="margin-left:auto">seen ${relTime(m.lastSeenAt)}</span>
        </li>`;
      })
      .join("");
  }

  const COLUMN_OF = {
    queued: "queued",
    assigned: "inflight",
    working: "inflight",
    "input-required": "needsinput",
    completed: "done",
    failed: "done",
    rejected: "done",
    canceled: "done",
  };

  function renderTasks(tasks) {
    const buckets = { queued: [], inflight: [], needsinput: [], done: [] };
    for (const t of tasks) (buckets[COLUMN_OF[t.status]] || buckets.done).push(t);

    for (const [col, items] of Object.entries(buckets)) {
      const ul = document.querySelector(`.task-list[data-col="${col}"]`);
      if (!state.show) {
        ul.innerHTML = `<li class="hint">no show selected</li>`;
        continue;
      }
      ul.innerHTML = items.length ? items.map(taskItemHtml).join("") : `<li class="hint">empty</li>`;
    }

    document.querySelectorAll(".task-item").forEach((node) => {
      node.addEventListener("click", () => {
        const id = node.dataset.id;
        state.expanded.has(id) ? state.expanded.delete(id) : state.expanded.add(id);
        fetchState();
      });
    });
  }

  function taskItemHtml(t) {
    const expanded = state.expanded.has(t.id);
    const notes = expanded && t.notes
      ? `<div class="task-notes">${t.notes
          .map((n) => `<div>${escapeHtml(n.author)}: ${escapeHtml(n.body)} <span class="hint">(${relTime(n.createdAt)})</span></div>`)
          .join("")}</div>`
      : "";
    return `<li class="task-item" data-id="${escapeHtml(t.id)}">
      <div class="task-row">
        <span class="task-title">${escapeHtml(t.title)}</span>
        <span class="badge">p${t.priority}</span>
      </div>
      <div class="hint">${escapeHtml(t.id)} &middot; ${t.assignee ? escapeHtml(t.assignee) : "unassigned"} &middot; attempt ${t.attempt} &middot; ${relTime(t.updatedAt)}</div>
      ${notes}
    </li>`;
  }

  function renderNotes(board) {
    const list = el("notes-list");
    if (!board) {
      list.innerHTML = `<li class="hint">no show selected</li>`;
      return;
    }
    const notes = board.recentNotes || [];
    if (!notes.length) {
      list.innerHTML = `<li class="hint">no notes yet</li>`;
      return;
    }
    // board.recentNotes arrives newest-first (api.ts); render as-is.
    list.innerHTML = notes.map(noteItemHtml).join("");
  }

  function noteItemHtml(n) {
    const tags = (n.tags || []).map((t) => `<span class="badge">${escapeHtml(t)}</span>`).join("");
    const body = n.body.length > NOTE_BODY_TRIM ? `${n.body.slice(0, NOTE_BODY_TRIM)}…` : n.body;
    return `<li>
      <div class="note-row">
        <span class="who">${escapeHtml(n.author)}</span>
        ${tags}
        <span class="when">${relTime(n.createdAt)}</span>
      </div>
      <div class="note-body">${escapeHtml(body)}</div>
    </li>`;
  }

  function renderActivity(board) {
    const list = el("activity-list");
    if (!board) {
      list.innerHTML = `<li class="hint">no show selected</li>`;
      return;
    }
    const notes = [];
    for (const t of board.tasks) {
      for (const n of t.notes || []) notes.push({ who: n.author, body: `[${t.title}] ${n.body}`, at: n.createdAt });
    }
    for (const m of board.recentMessages || []) {
      notes.push({ who: m.fromId, body: `-> ${m.toId}: ${m.body}`, at: m.createdAt });
    }
    notes.sort((a, b) => b.at - a.at);
    const top = notes.slice(0, 50);
    list.innerHTML = top.length
      ? top.map((n) => `<li><span class="who">${escapeHtml(n.who)}</span> ${escapeHtml(n.body)} <span class="when">${relTime(n.at)}</span></li>`).join("")
      : `<li class="hint">no activity yet</li>`;
  }

  function renderBanner(escalations) {
    if (!escalations || (escalations.inputRequired.length === 0 && escalations.humanMessages.length === 0)) {
      banner.hidden = true;
      return;
    }
    banner.hidden = false;
    const items = [
      ...escalations.inputRequired.map((t) => `input needed: ${escapeHtml(t.title)} (${escapeHtml(t.id)})`),
      ...escalations.humanMessages.slice(-5).map((m) => `${escapeHtml(m.fromId)} -> human: ${escapeHtml(m.body)}`),
    ];
    banner.innerHTML = `<strong>needs attention</strong><ul>${items.map((i) => `<li>${i}</li>`).join("")}</ul>`;
  }

  // --- click-to-copy resume_hint (delegated: director/member rows are re-rendered every poll,
  // this listener isn't) ---

  document.addEventListener("click", async (ev) => {
    const btn = ev.target.closest(".copy-hint");
    if (!btn) return;
    const hint = btn.dataset.hint || "";
    try {
      await navigator.clipboard.writeText(hint);
      btn.textContent = "copied";
    } catch {
      btn.textContent = "copy failed";
    }
    setTimeout(() => {
      btn.textContent = "copy";
    }, 1500);
  });

  // --- token + show picker wiring ---

  // ?token= handshake lands here with the token in the fragment: store it, hide it.
  if (location.hash.startsWith("#token=")) {
    saveToken(decodeURIComponent(location.hash.slice(7)));
    history.replaceState(null, "", location.pathname + location.search);
  }

  tokenInput.value = state.token;
  tokenStatus.textContent = state.token ? "saved" : "enter token to load shows";
  el("token-save").addEventListener("click", () => {
    saveToken(tokenInput.value.trim());
    loadShows();
  });
  showSelect.addEventListener("change", () => selectShow(showSelect.value));

  if (state.token) loadShows();
  setInterval(() => {
    if (state.token) loadShows();
  }, 10000); // pick up newly-registered shows without a manual refresh
})();
