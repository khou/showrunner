// Callboard: single-file, no build step. Polls GET /api/shows/:show/state every 2s and renders
// director/members/tasks/activity/escalations. A window, not a control panel (DESIGN.md):
// no task forms, no message box, no admin actions -- those live in the CLI against the same
// /api the poll here reads. Steer the show by talking to the director agent in its own chat,
// which the chat link below opens.
//
// Nomenclature: a "member" is any registered session; "worker" and "director" are roles a
// member holds. UI copy says "member"; roles appear only as badges and in role-specific
// phrases like the worker prompt.
(function () {
  "use strict";

  const TOKEN_KEY = "showrunner_token";
  const SHOW_KEY = "showrunner_show";
  const POLL_MS = 2000;
  const NOTE_BODY_TRIM = 140;
  const ACTIVITY_LIMIT = 50;

  const state = {
    token: localStorage.getItem(TOKEN_KEY) || "",
    show: localStorage.getItem(SHOW_KEY) || "",
    expanded: new Set(), // task ids with journal expanded
    pollTimer: null,
    showEvicted: false,
  };

  const el = (id) => document.getElementById(id);
  const showSelect = el("show-select");
  const showEmptyHint = el("show-empty-hint");
  const tokenInput = el("token-input");
  const tokenStatus = el("token-status");
  const lastPoll = el("last-poll");

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
      state.token = "";
      localStorage.removeItem(TOKEN_KEY);
      tokenBox.hidden = false;
      tokenStatus.textContent = "invalid token; paste a valid one";
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
    const urlShowNow = new URLSearchParams(location.search).get("show");
    const prev = urlShowNow || showSelect.value || state.show;
    showSelect.innerHTML = shows.length
      ? shows.map((s) => `<option value="${escapeHtml(s.name)}">${escapeHtml(s.name)}</option>`).join("")
      : '<option value="">(no shows yet)</option>';
    const pick = shows.find((s) => s.name === prev) ? prev : shows[0] ? shows[0].name : "";
    showSelect.value = pick;
    if (pick !== state.show) selectShow(pick);
    else if (pick) {
      // Ensure URL stays in sync even when localStorage already matched.
      const url = new URL(location.href);
      url.searchParams.set("show", pick);
      history.replaceState(null, "", url.pathname + url.search + url.hash);
      // Deep link / reload where the stored show already matches: selectShow was skipped
      // above, so polling has to start here or the board sits on its placeholders forever.
      if (!state.pollTimer) startPolling();
    }
  }

  function selectShow(show) {
    state.show = show;
    localStorage.setItem(SHOW_KEY, show);
    state.expanded.clear();
    stopPolling();
    // Keep ?show= in the URL for shareable deep links (never put the token back).
    const url = new URL(location.href);
    if (show) url.searchParams.set("show", show);
    else url.searchParams.delete("show");
    history.replaceState(null, "", url.pathname + url.search + url.hash);
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
    const show = state.show;
    try {
      const data = await api(`/api/shows/${encodeURIComponent(show)}/state`);
      // A slow response can land after the user switched shows; rendering it would overwrite
      // the new show's board until the next tick.
      if (show !== state.show) return;
      render(data);
      lastPoll.textContent = `updated ${relTime(Date.now())}`;
    } catch (err) {
      if (show !== state.show) return;
      lastPoll.textContent = `poll failed: ${err.message}`;
    }
  }

  // --- rendering ---

  function render(board) {
    const director = board && board.director;
    // The seat holder's member row is filtered out of the members list, so its
    // liveness/identity details render on the director card instead.
    const directorMember = director ? ((board && board.members) || []).find((m) => m.id === director.memberId) : null;
    renderDirector(director, directorMember);
    renderMembers(board);
    renderRules(board && board.rules);
    renderTasks(board);
    renderActivity(board);
    renderQueueBanner(board);
  }

  // Server-held show rules, display-only (the callboard is a read-only window). Switches show as
  // on/off text; the human changes them via `showrunner rules set` or the director's update_rules.
  function renderRules(rules) {
    const body = el("rules-body");
    if (!body) return;
    if (!rules) {
      body.innerHTML = `<span class="hint">no show selected</span>`;
      return;
    }
    const s = rules.switches || {};
    const sw = (label, on) => `<li><span class="rule-state ${on ? "on" : "off"}">${on ? "on" : "off"}</span> ${label}</li>`;
    const num = (label, val) => `<li><span class="rule-num">${escapeHtml(String(val))}</span> ${label}</li>`;
    body.innerHTML = `
      <div class="hint">v${rules.version} · updated by ${escapeHtml(rules.updatedBy || "?")}</div>
      <ul class="rule-list">
        ${sw("require human release of new tasks", !!s.requireTaskRelease)}
        ${sw("require human merge approval", !!s.requireHumanMergeApproval)}
        ${sw("propagate worker notes to peers", !!s.workerNotePropagation)}
        ${num("artifact text max (chars)", s.artifactTextMaxChars)}
        ${num("artifact data max (bytes)", s.artifactDataMaxBytes)}
      </ul>
      <div class="rule-policy"><span class="hint">policy (advisory)</span><div>${rules.policy ? escapeHtml(rules.policy) : '<span class="hint">none</span>'}</div></div>`;
  }

  function renderQueueBanner(board) {
    const queueBanner = el("queue-banner");
    if (!queueBanner) return;
    if (!board || !state.show) {
      queueBanner.hidden = true;
      return;
    }
    const queued = (board.tasks || []).filter((t) => t.status === "queued").length;
    // The kind:"other"/displayName:"human" row is api.ts's stand-in for HTTP/CLI actions
    // (registered with role "worker"); it never pulls tasks, so don't let it hide the banner.
    // Evicted members can't pull tasks either (credential revoked), so they don't count as
    // live; heads-down members do (they'll re-poll once their current task lands).
    const tasksById = new Map(((board && board.tasks) || []).map((t) => [t.id, t]));
    const liveWorkers = (board.members || []).filter(
      (m) =>
        m.role === "worker" &&
        (!m.stale || isHeadsDown(m, tasksById)) &&
        !m.evicted &&
        !(m.kind === "other" && m.displayName === "human"),
    ).length;
    if (queued > 0 && liveWorkers === 0) {
      queueBanner.hidden = false;
      queueBanner.innerHTML = `<strong>${queued} task${queued === 1 ? "" : "s"} queued</strong>, no live worker members. Open a session and say: <code>You're a showrunner worker.</code>`;
    } else {
      queueBanner.hidden = true;
    }
  }

  // Director card / member row chat link (DESIGN.md "the chat link"): session_url renders as a
  // prominent "open chat" anchor, resume_hint (no session_url) as click-to-copy code, neither as
  // a dim hint the session didn't report one.
  function chatLinkHtml(entity) {
    if (entity.sessionUrl) {
      return `<a class="chat-open" href="${escapeHtml(entity.sessionUrl)}" target="_blank" rel="noopener">open chat &#8599;</a>`;
    }
    if (entity.resumeHint) {
      // resume_hint is self-reported by the session and not vetted by the server (member auth
      // proves who registered, not that this string is a safe command) -- label it so a
      // copy-paste isn't mistaken for a server-verified command.
      return `<code class="resume-hint">${escapeHtml(entity.resumeHint)}</code> <button type="button" class="copy-hint" data-hint="${escapeHtml(entity.resumeHint)}">copy</button> <span class="hint" title="self-reported by the session, not verified by the server">self-reported</span>`;
    }
    return `<span class="hint">no chat link reported</span>`;
  }

  // Dead-director recovery is display-only (the callboard is read-only, and there is no takeover
  // button by design): show the exact prompt the human pastes into a NEW session to recover the
  // show. That session must already carry the director token (from .env) -- no secret is shown here.
  function recoveryPromptHtml() {
    return `<div class="recovery">
      <div class="hint">no live director. In a session that has the director token (from your .env), paste:</div>
      <code class="recovery-prompt">You're now the director of ${escapeHtml(state.show)}.</code>
    </div>`;
  }

  function renderDirector(director, member) {
    const body = el("director-body");
    if (!state.show) {
      body.textContent = "no show selected";
      return;
    }
    if (!director) {
      body.innerHTML = `<span class="hint">no director -- show is headless</span>${recoveryPromptHtml()}`;
      return;
    }
    const dot = director.stale ? "stale" : "fresh";
    // Provenance: how this holder got the seat (audit log). A stale lease no longer opens the
    // seat, so showing "how/when" makes an unexpected holder easy to spot.
    const p = director.provenance;
    const prov = p ? `<div class="hint">seat: ${escapeHtml(p.method)} &middot; ${relTime(p.at)}</div>` : "";
    // A stale holder still holds the seat (no transfer by timeout); surface the recovery prompt so
    // the human can spin up a replacement director session that takes over.
    const recovery = director.stale ? recoveryPromptHtml() : "";
    const desc = member && member.displayName ? ` <span class="hint">${escapeHtml(member.displayName)}</span>` : "";
    const kind = member ? ` <span class="badge">${escapeHtml(member.kind)}</span>` : "";
    const seen = member ? ` &middot; seen ${relTime(member.lastSeenAt)}` : "";
    body.innerHTML = `
      <div><span class="dot ${dot}"></span> ${escapeHtml(director.memberId)}${desc}${kind}</div>
      <div class="hint">epoch ${director.epoch} &middot; ${director.stale ? "lease expired (still holds the seat)" : "lease active"}${seen}</div>
      ${prov}
      <div class="chat-link">${chatLinkHtml(director)}</div>
      ${recovery}
    `;
  }

  // A member whose poll lease lapsed while it holds a live in-flight task is heads-down
  // (working, quiet), not gone: the reaper judges assigned/working tasks by the task lease
  // alone, so the board mirrors that instead of flashing red at every tool-free stretch.
  function isHeadsDown(m, tasksById) {
    if (!m.stale || !m.currentTaskId) return false;
    const t = tasksById.get(m.currentTaskId);
    return !!(t && (t.status === "assigned" || t.status === "working") && t.leaseExpiresAt && t.leaseExpiresAt > Date.now());
  }

  // The "now" line: what this member is doing right now, joined to the task list so it reads
  // as a title, not an opaque task id.
  function memberNowHtml(m, tasksById) {
    if (!m.currentTaskId) {
      return `<div class="member-now idle"><span class="now-label">idle</span></div>`;
    }
    const t = tasksById.get(m.currentTaskId);
    if (!t) {
      return `<div class="member-now"><span class="now-label">on</span> <span class="now-title">${escapeHtml(m.currentTaskId)}</span></div>`;
    }
    return `<div class="member-now">
      <span class="now-label status-${escapeHtml(t.status)}">${escapeHtml(t.status)}</span>
      <span class="now-title" title="${escapeHtml(t.id)}">${escapeHtml(t.title)}</span>
      <span class="hint">${relTime(t.updatedAt)}</span>
    </div>`;
  }

  function renderMembers(board) {
    const list = el("members-list");
    const toggle = el("evicted-toggle");
    if (!state.show) {
      list.innerHTML = `<li class="hint">no show selected</li>`;
      if (toggle) toggle.hidden = true;
      return;
    }
    // The current seat holder already renders on the director card; repeating it here made
    // the director read as one more member. The kind:"other"/"human" row is api.ts's synthetic
    // audit actor for HTTP/CLI writes, not a session anyone can talk to -- hide it too.
    const directorId = board && board.director ? board.director.memberId : null;
    const members = (board ? board.members : []).filter(
      (m) => m.id !== directorId && !(m.kind === "other" && m.displayName === "human"),
    );
    const evictedCount = members.filter((m) => m.evicted).length;
    if (toggle) {
      toggle.hidden = evictedCount === 0 && !state.showEvicted;
      toggle.textContent = state.showEvicted ? `hide evicted (${evictedCount})` : `show evicted (${evictedCount})`;
    }
    const visible = state.showEvicted ? members : members.filter((m) => !m.evicted);
    if (!visible.length) {
      list.innerHTML = members.length
        ? `<li class="hint">no active members (${evictedCount} evicted hidden)</li>`
        : `<li class="hint">no members registered yet</li>`;
      return;
    }
    const tasks = (board && board.tasks) || [];
    const tasksById = new Map(tasks.map((t) => [t.id, t]));
    const doneBy = new Map();
    for (const t of tasks) {
      if (t.status === "completed" && t.assignee) doneBy.set(t.assignee, (doneBy.get(t.assignee) || 0) + 1);
    }
    list.innerHTML = visible
      .map((m) => {
        const headsDown = isHeadsDown(m, tasksById);
        const dot = headsDown ? "headsdown" : m.stale ? "stale" : "fresh";
        const chat = m.sessionUrl
          ? ` <a class="chat-open-small" href="${escapeHtml(m.sessionUrl)}" target="_blank" rel="noopener" title="open chat">&#8599;</a>`
          : "";
        const desc = m.displayName ? `<span class="hint member-desc">${escapeHtml(m.displayName)}</span>` : "";
        // Director-visibility badges: evicted membership (credential revoked by the director) and
        // invite provenance (joined via a director-minted invite). Display only.
        const evictedBadge = m.evicted ? `<span class="badge badge-evicted" title="evicted by ${escapeHtml(m.evictedBy || "director")}">EVICTED</span>` : "";
        const inviteBadge = m.invitedBy ? `<span class="badge" title="invited by ${escapeHtml(m.invitedBy)}">invited</span>` : "";
        return `<li class="member-item${m.evicted ? " member-evicted" : ""}">
          <div class="member-row">
            <span class="dot ${dot}"></span>
            <span class="member-id">${escapeHtml(m.id)}</span>${chat}
            ${desc}
            <span class="badge">${escapeHtml(m.kind)}</span>
            <span class="badge role-${escapeHtml(m.role)}">${escapeHtml(m.role)}</span>
            ${inviteBadge}
            ${evictedBadge}
            <span class="hint member-seen">${headsDown ? "heads-down &middot; " : m.stale ? "lease expired &middot; " : ""}seen ${relTime(m.lastSeenAt)}</span>
          </div>
          ${m.evicted ? "" : memberNowHtml(m, tasksById)}
          <div class="hint member-meta">${doneBy.get(m.id) || 0} done &middot; joined ${relTime(m.registeredAt)}</div>
        </li>`;
      })
      .join("");
  }

  // Three columns of things worth reading here: what's waiting (queued), what's blocked on a
  // human/director decision (needs input, plus messages addressed to `human`), and what agents
  // reported back as failed/rejected. In-flight lives on the members hero (it IS what members
  // are working on); completed work just gets merged, so neither earns a column -- both stay
  // visible as totals in the tasks header.
  const COLUMN_OF = {
    queued: "queued",
    "input-required": "needsinput",
    failed: "failures",
    rejected: "failures",
  };

  // Per-column order. Queued mirrors await_work's claim order (priority DESC, age ASC) so the
  // top of the column is first in line -- modulo dependencies and pinned assignees, which
  // claimNextTask also honors; needs-input floats the longest-blocked decision to the top;
  // failures put the freshest report first.
  const SORT_OF = {
    queued: (a, b) => b.priority - a.priority || a.createdAt - b.createdAt,
    needsinput: (a, b) => a.updatedAt - b.updatedAt,
    failures: (a, b) => b.updatedAt - a.updatedAt,
  };

  const FAILURES_SHOWN = 20;
  const HUMAN_MSG_TTL_MS = 24 * 60 * 60 * 1000;
  const ATTENTION_PULSE_MS = 2000; // must match attention-pulse duration in callboard.css

  // Every poll recreates the pulsing nodes, which would restart the animation at 0% and make
  // the glow stutter; a wall-clock-phased negative delay lets the new node resume mid-cycle.
  function pulsePhaseAttr() {
    return ` style="animation-delay:-${Date.now() % ATTENTION_PULSE_MS}ms"`;
  }

  function setCount(key, n) {
    const span = document.querySelector(`.count[data-count="${key}"]`);
    if (span) span.textContent = n === null ? "" : `(${n})`;
  }

  function renderTasks(board) {
    const totals = el("task-totals");
    const tasks = (board && board.tasks) || [];
    const buckets = { queued: [], needsinput: [], failures: [] };
    for (const t of tasks) {
      const col = COLUMN_OF[t.status];
      if (col) buckets[col].push(t);
    }

    if (!state.show) {
      for (const col of Object.keys(buckets)) {
        document.querySelector(`.task-list[data-col="${col}"]`).innerHTML = `<li class="hint">no show selected</li>`;
        setCount(col, null);
      }
      if (totals) totals.textContent = "";
      return;
    }

    // In-flight and done have no column (members hero / merged away), so the header carries
    // their totals; counts come from taskCounts, which covers every task ever, not just the
    // bounded list in the payload.
    const counts = (board && board.taskCounts) || {};
    if (totals) {
      const inFlight = (counts.assigned || 0) + (counts.working || 0);
      const parts = [`${inFlight} in flight`, `${counts.completed || 0} done`];
      if (counts.canceled) parts.push(`${counts.canceled} canceled`);
      totals.textContent = parts.join(" · ");
    }

    for (const [col, items] of Object.entries(buckets)) {
      const ul = document.querySelector(`.task-list[data-col="${col}"]`);
      items.sort(SORT_OF[col]);
      let shown = items;
      let overflow = "";
      if (col === "failures" && items.length > FAILURES_SHOWN) {
        shown = items.slice(0, FAILURES_SHOWN);
        overflow = `<li class="hint">showing latest ${FAILURES_SHOWN} of ${items.length}</li>`;
      }
      let html = shown.map((t) => taskItemHtml(t, col)).join("") + overflow;
      let count = items.length;
      if (col === "needsinput" && board && board.escalations) {
        // Messages addressed to `human` are escalations too; they live here so decisions
        // waiting on you have exactly one home. There is no ack/read mechanism for the human,
        // so bound by recency or a message would pulse amber forever.
        const msgs = board.escalations.humanMessages
          .filter((m) => Date.now() - m.createdAt < HUMAN_MSG_TTL_MS)
          .slice(-5);
        html += msgs.map(humanMessageHtml).join("");
        count += msgs.length;
      }
      ul.innerHTML = html || `<li class="hint">empty</li>`;
      setCount(col, count);
    }

    document.querySelectorAll(".task-item").forEach((node) => {
      node.addEventListener("click", () => {
        const id = node.dataset.id;
        state.expanded.has(id) ? state.expanded.delete(id) : state.expanded.add(id);
        fetchState();
      });
    });
  }

  // A failed/rejected task's card carries what the agent reported back: the last journal
  // entry, stamped with when it was originally written.
  function failureReportHtml(t) {
    const report = t.notes && t.notes.length ? t.notes[t.notes.length - 1] : null;
    if (!report) return "";
    return `<div class="failure-report">${escapeHtml(report.author)}: ${escapeHtml(report.body)} <span class="hint">(${relTime(report.createdAt)})</span></div>`;
  }

  function humanMessageHtml(m) {
    return `<li class="msg-item attention"${pulsePhaseAttr()}>
      <div class="hint"><span class="who">${escapeHtml(m.fromId)}</span> -&gt; human &middot; ${relTime(m.createdAt)}</div>
      <div>${escapeHtml(m.body)}</div>
    </li>`;
  }

  function taskItemHtml(t, col) {
    const expanded = state.expanded.has(t.id);
    const notes = expanded && t.notes
      ? `<div class="task-notes">${t.notes
          .map((n) => `<div>${escapeHtml(n.author)}: ${escapeHtml(n.body)} <span class="hint">(${relTime(n.createdAt)})</span></div>`)
          .join("")}</div>`
      : "";
    // queued/needs-input are single-status columns; failures mixes failed + rejected.
    const statusBadge = col === "failures"
      ? `<span class="badge status-${escapeHtml(t.status)}">${escapeHtml(t.status)}</span>`
      : "";
    const attention = col === "needsinput" ? " attention" : "";
    // Release gate (display only; the callboard is a read-only window): a queued task withheld by
    // the requireTaskRelease rule shows a PENDING RELEASE badge so the human sees the checkpoint.
    // Releasing happens via `showrunner task release`, not here. (Only queued tasks can be
    // withheld, and only needs-input pulses, so the two never co-occur on one card.)
    const pending = t.status === "queued" && t.released === false;
    const pendingUi = pending
      ? `<span class="badge badge-hold" title="withheld until a human releases it with: showrunner task release">PENDING RELEASE</span>`
      : "";
    return `<li class="task-item${attention}${pending ? " task-hold" : ""}"${attention ? pulsePhaseAttr() : ""} data-id="${escapeHtml(t.id)}">
      <div class="task-row">
        <span class="task-title">${escapeHtml(t.title)}</span>
        ${statusBadge}
        <span class="badge">p${t.priority}</span>
        ${pendingUi}
      </div>
      <div class="hint">${escapeHtml(t.id)} &middot; ${t.assignee ? escapeHtml(t.assignee) : "unassigned"} &middot; attempt ${t.attempt} &middot; ${relTime(t.updatedAt)}</div>
      ${col === "failures" && !expanded ? failureReportHtml(t) : ""}
      ${notes}
    </li>`;
  }

  // One demoted feed (collapsed by default): shared notes + task journal entries + messages,
  // newest first. The board's job is members + queue; this is the paper trail when you need it.
  function renderActivity(board) {
    const list = el("activity-list");
    const summary = el("activity-summary");
    if (!board) {
      list.innerHTML = `<li class="hint">no show selected</li>`;
      if (summary) summary.textContent = "activity";
      return;
    }
    const entries = [];
    for (const n of board.recentNotes || []) {
      const tags = (n.tags || []).map((t) => `<span class="badge">${escapeHtml(t)}</span>`).join(" ");
      const body = n.body.length > NOTE_BODY_TRIM ? `${n.body.slice(0, NOTE_BODY_TRIM)}…` : n.body;
      entries.push({ at: n.createdAt, html: `<span class="who">${escapeHtml(n.author)}</span> <span class="badge">note</span> ${tags} ${escapeHtml(body)}` });
    }
    for (const t of board.tasks || []) {
      for (const n of t.notes || []) {
        entries.push({ at: n.createdAt, html: `<span class="who">${escapeHtml(n.author)}</span> [${escapeHtml(t.title)}] ${escapeHtml(n.body)}` });
      }
    }
    for (const m of board.recentMessages || []) {
      // kind:"note" messages are save_note's realtime echoes to overlapping members; the note
      // itself is already in recentNotes above, so rendering the echoes would duplicate it.
      if (m.kind === "note") continue;
      entries.push({ at: m.createdAt, html: `<span class="who">${escapeHtml(m.fromId)}</span> -&gt; ${escapeHtml(m.toId)}: ${escapeHtml(m.body)}` });
    }
    entries.sort((a, b) => b.at - a.at);
    const top = entries.slice(0, ACTIVITY_LIMIT);
    if (summary) summary.textContent = top.length ? `activity (${top.length})` : "activity";
    list.innerHTML = top.length
      ? top.map((e) => `<li><span class="entry">${e.html}</span><span class="when">${relTime(e.at)}</span></li>`).join("")
      : `<li class="hint">no activity yet</li>`;
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

  // Prefer ?show= deep link, then localStorage.
  const urlShow = new URLSearchParams(location.search).get("show");
  if (urlShow) {
    state.show = urlShow;
    localStorage.setItem(SHOW_KEY, urlShow);
  }

  // ?token= handshake lands here with the token in the fragment: store it, hide it.
  if (location.hash.startsWith("#token=")) {
    saveToken(decodeURIComponent(location.hash.slice(7)));
    history.replaceState(null, "", location.pathname + location.search);
  }

  // The token box only exists for the unauthenticated empty state; once a token is
  // stored (via the ?token= link handshake or a one-time paste) it disappears. The
  // token itself is never rendered back into the page.
  const tokenBox = el("token-box");
  const authEmpty = el("auth-empty");
  const boardMain = el("board-main");
  function syncAuthUi() {
    tokenBox.hidden = Boolean(state.token);
    if (authEmpty) authEmpty.hidden = Boolean(state.token);
    if (boardMain) boardMain.hidden = !state.token;
    if (!state.token) {
      tokenStatus.textContent = "open your ?token= link, run showrunner open, or paste the token";
      showEmptyHint.hidden = true;
    }
  }
  syncAuthUi();
  tokenInput.value = "";
  el("token-save").addEventListener("click", () => {
    saveToken(tokenInput.value.trim());
    tokenInput.value = "";
    syncAuthUi();
    loadShows();
  });
  showSelect.addEventListener("change", () => selectShow(showSelect.value));
  el("evicted-toggle").addEventListener("click", () => {
    state.showEvicted = !state.showEvicted;
    fetchState();
  });

  if (state.token) loadShows();
  setInterval(() => {
    if (state.token) loadShows();
  }, 10000); // pick up newly-registered shows without a manual refresh
})();
