"use client";
/**
 * "My plate" on Overview: what's waiting on you (finished work to check,
 * friends' tasks your agents need your OK for, and mentions of you), what you
 * and your agents are doing, what's next for you, and what your agents
 * finished in the last day, across every list. A task opens in the Lists
 * tab's drawer; an OK is one tap right here.
 */
import { useCallback, useMemo, useState } from "react";
import { EmptyState, SkeletonRows } from "@/components/ui/primitives";
import { listsApi, errorText, useListChanges, openListsAt, whoName, elapsed, lapsesIn, ago, type MentionView, type Plate, type TaskView } from "./api";
import { WhoAvatar, DueChip, MentionText, Byline } from "./bits";
import { mentionDirectory } from "./mentions.mjs";

const SHOW = 4;

export function PlateCard({ demoMode, onOpen }: { demoMode: boolean; onOpen: () => void }) {
  const [plate, setPlate] = useState<Plate | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState("");
  const [okErr, setOkErr] = useState<{ id: string; msg: string } | null>(null);

  const load = useCallback(async () => {
    try {
      setPlate(await listsApi.plate());
      setErr("");
    } catch (e) {
      setErr(errorText(e));
    }
  }, []);
  useListChanges(load, !demoMode);

  const open = (target: Parameters<typeof openListsAt>[0]) => { openListsAt(target); onOpen(); };
  const openTask = (t: TaskView) => open({ listId: t.list.id, taskId: t.id });

  const okTask = async (t: TaskView) => {
    setBusy(t.id); setOkErr(null);
    try {
      await listsApi.okTask(t.id);
      await load();
    } catch (e) {
      setOkErr({ id: t.id, msg: errorText(e) });
    } finally {
      setBusy("");
    }
  };

  // Mentions of you are highlighted; the plate doesn't carry the rest of each list's people.
  const youDir = useMemo(() => {
    const me = plate?.mentions[0]?.of;
    return mentionDirectory(me?.handle ? [{ handle: me.handle, display_name: me.person, is_you: true, agents: [] }] : []);
  }, [plate]);

  const head = (
    <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
      <h2 className="ds-cardh">My plate</h2>
      {!demoMode && <button className="ds-link" style={{ marginLeft: "auto" }} onClick={() => open({})}>Open Lists</button>}
    </div>
  );

  if (demoMode) {
    return (
      <div className="ds-card">
        {head}
        <EmptyState icon="☑">Sign in to see what you and your agents have on your lists.</EmptyState>
      </div>
    );
  }

  if (!plate) {
    return (
      <div className="ds-card">
        {head}
        {err ? <p className="ds-fine" style={{ margin: 0 }}>{err}</p> : <SkeletonRows rows={3} />}
      </div>
    );
  }

  const emoji = new Map(plate.lists.map((l) => [l.id, l.emoji]));
  const where = (t: TaskView) => `${emoji.get(t.list.id) ? `${emoji.get(t.list.id)} ` : ""}${t.list.name}`;
  const youDoing = plate.doing.filter((t) => !t.claim?.by?.agent);
  const agentsDoing = plate.doing.filter((t) => !!t.claim?.by?.agent);
  const okRequests = plate.ok_requests ?? [];
  const mentions = plate.mentions ?? [];
  const waiting = plate.waiting_on_you.length + okRequests.length + mentions.length;
  const nothing = !plate.doing.length && !plate.up_next.length && !waiting && !plate.done_recently.length;

  const item = (t: TaskView, kind: "doing" | "next" | "waiting" | "done") => {
    const by = kind === "doing" ? t.claim?.by : kind === "waiting" || kind === "done" ? t.completed_by : null;
    const meta =
      kind === "doing"
        ? [t.claim?.since ? elapsed(t.claim.since) : "", t.claim?.by?.agent && t.claim.lapses_at ? lapsesIn(t.claim.lapses_at) : "", t.status === "blocked" ? "blocked" : "", t.claim?.stale ? "still on it?" : ""]
        : kind === "waiting"
          ? [`${whoName(t.completed_by)} finished it`]
          : kind === "done"
            ? [ago(t.completed_at)]
            : [];
    const line = (kind === "waiting" || kind === "done") && t.summary ? t.summary.split("\n")[0] : "";
    return (
      <button key={`${kind}-${t.id}`} className="ds-plate-item" onClick={() => openTask(t)}>
        {by ? <WhoAvatar who={by} size={26} pulse={kind === "doing" && !!by.agent && t.status === "in_progress"} /> : <span className={`ds-task-check${kind === "done" ? " done" : ""}`} aria-hidden />}
        <span style={{ minWidth: 0, flex: 1 }}>
          <span className="ds-task-title" style={{ display: "block" }}>{t.title}</span>
          {line && <span className="ds-task-line progress" style={{ display: "block" }}>&ldquo;{line}&rdquo;</span>}
          <span className="ds-imeta" style={{ display: "block" }}>
            {where(t)}
            {(kind === "doing" || kind === "done") && by && <> · <Byline who={by} /></>}
            {meta.filter(Boolean).map((m) => ` · ${m}`).join("")}
          </span>
        </span>
        <DueChip due={t.due} />
      </button>
    );
  };

  /** A friend's task your agents need your OK for: open it, or OK it right here. */
  const okItem = (t: TaskView) => (
    <div key={`ok-${t.id}`} className="ds-plate-row">
      <button className="ds-plate-item" onClick={() => openTask(t)}>
        <WhoAvatar who={t.created_by} size={26} />
        <span style={{ minWidth: 0, flex: 1 }}>
          <span className="ds-task-title" style={{ display: "block" }}>{t.title}</span>
          <span className="ds-imeta" style={{ display: "block" }}>
            {where(t)} · {whoName(t.created_by)} added it{t.assignee?.kind === "their_agents" ? " for your agents" : t.assignee ? " for you" : ""}. Your agents need your OK.
          </span>
          {okErr?.id === t.id && <span className="ds-err" role="alert" style={{ display: "block", margin: "4px 0 0" }}>{okErr.msg}</span>}
        </span>
      </button>
      <button className="ds-btn ds-sm" disabled={busy === t.id} title={t.agent_may_act.why} onClick={() => void okTask(t)}>
        {busy === t.id ? "…" : "OK for my agents"}
      </button>
    </div>
  );

  const mentionItem = (m: MentionView) => {
    const text = m.entry.text.replace(/\s+/g, " ");
    const snippet = text.length > 140 ? `${text.slice(0, 139)}…` : text;
    return (
      <button key={`m-${m.id}`} className="ds-plate-item" onClick={() => openTask(m.task)}>
        <WhoAvatar who={m.entry.by} size={26} />
        <span style={{ minWidth: 0, flex: 1 }}>
          <span className="ds-task-title" style={{ display: "block" }}><Byline who={m.entry.by} /> mentioned you</span>
          <span className="ds-task-line" style={{ display: "block" }}><MentionText inline text={snippet} dir={youDir} author={m.entry.by} /></span>
          <span className="ds-imeta" style={{ display: "block" }}>{where(m.task)} · {m.task.title} · {ago(m.entry.at)}</span>
        </span>
      </button>
    );
  };

  const more = (n: number) => n > 0 && <button className="ds-link" style={{ margin: "2px 6px 0" }} onClick={() => open({})}>and {n} more</button>;

  const section = (label: string, tasks: TaskView[], kind: "doing" | "next" | "waiting" | "done") =>
    tasks.length > 0 && (
      <>
        <div className="ds-plate-sec">{label}</div>
        {tasks.slice(0, SHOW).map((t) => item(t, kind))}
        {more(tasks.length - SHOW)}
      </>
    );

  // Waiting on you: results to check first, then OKs, then mentions, SHOW in all.
  const waitingSection = () => {
    if (!waiting) return null;
    const rows: React.ReactNode[] = [
      ...plate.waiting_on_you.map((t) => item(t, "waiting")),
      ...okRequests.map(okItem),
      ...mentions.map(mentionItem),
    ];
    return (
      <>
        <div className="ds-plate-sec">Waiting on you</div>
        {rows.slice(0, SHOW)}
        {more(rows.length - SHOW)}
      </>
    );
  };

  return (
    <div className="ds-card">
      {head}
      <p className="ds-cardsub">What needs you and your agents, across your lists.</p>
      {plate.lists.length === 0 ? (
        <EmptyState icon="☑">
          No lists yet. Start one for anything you and your agents should keep track of.{" "}
          <button className="ds-link" onClick={() => open({ newList: true })}>Start a list</button>
        </EmptyState>
      ) : nothing ? (
        <EmptyState icon="☑">
          Nothing on your plate right now.{" "}
          {plate.claimable.length > 0
            ? <button className="ds-link" onClick={() => open({})}>{plate.claimable.length} task{plate.claimable.length === 1 ? " is" : "s are"} free to pick up</button>
            : <button className="ds-link" onClick={() => open({})}>Add a task</button>}
        </EmptyState>
      ) : (
        <>
          {waitingSection()}
          {section("You're doing", youDoing, "doing")}
          {section("Your agents are doing", agentsDoing, "doing")}
          {section("Up next for you", plate.up_next, "next")}
          {section("Your agents finished, last 24 hours", plate.done_recently, "done")}
          {plate.claimable.length > 0 && (
            <p className="ds-fine" style={{ margin: "10px 6px 0" }}>
              {plate.claimable.length} more task{plate.claimable.length === 1 ? " is" : "s are"} free for anyone to pick up. <button className="ds-link" style={{ fontSize: 12 }} onClick={() => open({})}>See them</button>
            </p>
          )}
        </>
      )}
      {err && <p className="ds-fine" style={{ marginTop: 8 }}>{err}</p>}
    </div>
  );
}
