"use client";
/**
 * "My plate" on Overview: what you and your agents are doing, what's next for
 * you, finished work waiting for your look, and what your agents finished in
 * the last day, across every list. A task opens in the Lists tab's drawer.
 */
import { useCallback, useState } from "react";
import { EmptyState, SkeletonRows } from "@/components/ui/primitives";
import { listsApi, errorText, useListChanges, openListsAt, whoName, elapsed, lapsesIn, ago, type Plate, type TaskView } from "./api";
import { WhoAvatar, DueChip } from "./bits";

const SHOW = 4;

export function PlateCard({ demoMode, onOpen }: { demoMode: boolean; onOpen: () => void }) {
  const [plate, setPlate] = useState<Plate | null>(null);
  const [err, setErr] = useState("");

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
  const youDoing = plate.doing.filter((t) => !t.claim?.by?.agent);
  const agentsDoing = plate.doing.filter((t) => !!t.claim?.by?.agent);
  const nothing = !plate.doing.length && !plate.up_next.length && !plate.waiting_on_you.length && !plate.done_recently.length;

  const item = (t: TaskView, kind: "doing" | "next" | "waiting" | "done") => {
    const by = kind === "doing" ? t.claim?.by : kind === "waiting" || kind === "done" ? t.completed_by : null;
    const meta =
      kind === "doing"
        ? [t.claim?.since ? elapsed(t.claim.since) : "", t.claim?.by?.agent && t.claim.lapses_at ? lapsesIn(t.claim.lapses_at) : "", t.status === "blocked" ? "blocked" : "", t.claim?.stale ? "still on it?" : ""]
        : kind === "waiting"
          ? [`${whoName(t.completed_by)} finished it`]
          : kind === "done"
            ? [`${whoName(t.completed_by)} · ${ago(t.completed_at)}`]
            : [];
    const line = (kind === "waiting" || kind === "done") && t.summary ? t.summary.split("\n")[0] : "";
    return (
      <button key={`${kind}-${t.id}`} className="ds-plate-item" onClick={() => openTask(t)}>
        {by ? <WhoAvatar who={by} size={26} pulse={kind === "doing" && !!by.agent && t.status === "in_progress"} /> : <span className={`ds-task-check${kind === "done" ? " done" : ""}`} aria-hidden />}
        <span style={{ minWidth: 0, flex: 1 }}>
          <span className="ds-task-title" style={{ display: "block" }}>{t.title}</span>
          {line && <span className="ds-task-line progress" style={{ display: "block" }}>&ldquo;{line}&rdquo;</span>}
          <span className="ds-imeta" style={{ display: "block" }}>
            {emoji.get(t.list.id) ? `${emoji.get(t.list.id)} ` : ""}{t.list.name}{meta.filter(Boolean).map((m) => ` · ${m}`).join("")}
          </span>
        </span>
        <DueChip due={t.due} />
      </button>
    );
  };

  const section = (label: string, tasks: TaskView[], kind: "doing" | "next" | "waiting" | "done") =>
    tasks.length > 0 && (
      <>
        <div className="ds-plate-sec">{label}</div>
        {tasks.slice(0, SHOW).map((t) => item(t, kind))}
        {tasks.length > SHOW && <button className="ds-link" style={{ margin: "2px 6px 0" }} onClick={() => open({})}>and {tasks.length - SHOW} more</button>}
      </>
    );

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
          {section("Waiting on you", plate.waiting_on_you, "waiting")}
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
