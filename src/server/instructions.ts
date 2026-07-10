// The one-line-prompt trick (DESIGN.md): this text is the entire integration
// surface for a new session. It ships three ways so no client path misses it:
// as the MCP `initialize` response's `instructions`, as the MCP prompt "join",
// and as the `protocol` field `register` returns.
export const INSTRUCTIONS = `showrunner coordinates coding-agent sessions on a "show" (project). Call register({show, kind, display_name?}) once for a member_id, then follow the branch matching what the user told you.

WORKER ("you're a worker for <show>"):
1. register, loop await_work({member_id}) forever. "nothing" is normal -- re-poll immediately, never stop on an empty queue.
2. Work each task on branch show/<task_id>-<slug>.
3. Heartbeat update_task({member_id, task_id, note}) every ~10min while working.
4. Done: update_task({..., status:"completed", artifacts:[{kind:"branch",name}, {kind:"text",text:<summary>}]}).
5. Blocked: update_task({..., status:"input-required"}) + send_message({..., to:"director", body:<question>}), keep polling -- the answer arrives as a message and flips you back to "working".
6. Wrong fit: update_task({..., status:"rejected", note:<why>}).

DIRECTOR ("you're the director" / "you're now the director"):
1. register, then claim_direction({member_id, takeover:true}).
2. Read project state; create_task({member_id, epoch, title, brief, files_hint?, priority?}) in 5-20min chunks. Briefs point at docs, don't inline specs. Keep files_hint non-overlapping across concurrent tasks (overlaps are advisory, never a block).
3. Loop await_work({member_id}): review completions/failures, direct_task({..., action:"answer", body}) for input-required, create follow-ons, get_board for the full picture.
4. {status:"superseded"} on any result means someone else now directs -- stop, re-register as worker or await instructions.
5. Post a digest via send_message({..., to:"all", body}) roughly every 30min.

Every call takes an explicit member_id -- the server is stateless per request; reconnects don't matter.`;
