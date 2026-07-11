// The one-line-prompt trick (DESIGN.md): this text is the entire integration
// surface for a new session. It ships three ways so no client path misses it:
// as the MCP `initialize` response's `instructions`, as the MCP prompt "join",
// and as the `protocol` field `register` returns.
export const INSTRUCTIONS = `showrunner coordinates coding-agent sessions on a "show" (project). Call register({show, kind, display_name?}) once for a member_id, then follow the branch matching what the user told you.

SHOW NAME, in priority order: (1) a show the user names; (2) a .showrunner file at the repo root (single line, commit it so every clone and worktree agrees); (3) basename of the git origin remote (strip .git); (4) the working directory name. If register's result says you created a new show and lists similar_existing_shows, your derivation was probably wrong (checkout dirs often carry -w1/-copy/worktree suffixes): register again with the existing name unless you truly mean a new show.

At register, self-report how a human can open this session's chat: session_url if this session has one (claude.ai/code and cursor.com sessions know their own URL), or resume_hint for local CLI (e.g. "claude --resume $CLAUDE_SESSION_ID" when that env var is set). Omit both when unknown.

WORKER ("you're a showrunner worker" / "you're a worker for <show>"):
1. register, loop await_work({member_id}) forever. "nothing" is normal -- re-poll immediately, never stop on an empty queue.
2. A claimed task arrives with relevant_notes: prior notes worth reading before you start. search_notes({member_id, query}) for more.
3. Work each task on branch show/<task_id>-<slug>.
4. Heartbeat update_task({member_id, task_id, note}) every ~10min while working.
5. Done: update_task({..., status:"completed", artifacts:[{kind:"branch",name}, {kind:"text",text:<summary>}]}). Learned a gotcha, decision, or env quirk the next agent would want? save_note({member_id, body, files_hint?, task_id}) first -- it reaches related work automatically.
6. Blocked: update_task({..., status:"input-required"}) + send_message({..., to:"director", body:<question>}), keep polling -- the answer arrives as a message and flips you back to "working".
7. Wrong fit: update_task({..., status:"rejected", note:<why>}).

DIRECTOR ("you're the director" / "you're now the director"):
1. register, then claim_direction({member_id, takeover:true}).
2. Read project state; create_task({member_id, epoch, title, brief, files_hint?, priority?}) in 5-20min chunks. Briefs point at docs, don't inline specs. Keep files_hint non-overlapping across concurrent tasks (overlaps are advisory, never a block).
3. Loop await_work({member_id}): review completions/failures, direct_task({..., action:"answer", body}) for input-required, create follow-ons, get_board for the full picture.
4. save_note({member_id, body, tags?, files_hint?}) any generalizable decision -- especially an input-required answer -- so it isn't buried in one task's journal.
5. {status:"superseded"} on any result means someone else now directs -- stop, re-register as worker or await instructions.
6. Post a digest via send_message({..., to:"all", body}) roughly every 30min.

Every call takes an explicit member_id -- the server is stateless per request; reconnects don't matter.`;
