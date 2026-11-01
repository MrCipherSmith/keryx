import { useState } from "react";
import { useTranslation } from "react-i18next";
import { GitBranch, ArrowRight, Layers } from "lucide-react";
import { Input, Select, EmptyState } from "../../components/ui";
import { WorkBadge } from "./work-panels";
import type { WorkFlow, WorkIntent } from "./types";
export function FlowList({ flows, intentsByFlow, onSelect }: {flows: WorkFlow[]; intentsByFlow: Map<string,WorkIntent[]>; onSelect:(id:string)=>void}) {
 const {t} = useTranslation("work");
 const [search,setSearch] = useState("");
 const [filter,setFilter] = useState("");
 return (        <>
          <div className="work-filters">
            <Input
              aria-label={t("search")}
              placeholder={t("search")}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <Select
              aria-label={t("all")}
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            >
              <option value="">{t("all")}</option>
              {[
                "draft",
                "ready",
                "in-progress",
                "in-review",
                "accepted",
                "cancelled",
              ].map((state) => (
                <option key={state} value={state}>
                  {t("states." + state)}
                </option>
              ))}
            </Select>
          </div>
          {flows.length ? (
            <div className="work-flow-list">
              {flows
                .filter(
                  (f) =>
                    (!filter || f.state === filter) &&
                    f.title.toLowerCase().includes(search.toLowerCase()),
                )
                .map((f) => {
                  const children = (intentsByFlow.get(f.id) ?? []).filter((intent) => intent.required);
                  const accepted = children.filter(
                    (i) =>
                      i.state === "accepted" &&
                      i.currentRevisionId === i.approvedRevisionId,
                  ).length;
                  return (
                    <button
                      className="work-flow-row"
                      key={f.id}
                      onClick={() => {
                        onSelect(f.id);
                      }}
                    >
                      <GitBranch size={18} />
                      <span>
                        <strong>{f.title}</strong>
                        <small>
                          {t("owner")}: {f.ownerId ?? "—"}
                        </small>
                      </span>
                      <WorkBadge value={f.state} />
                      <span className="work-progress">
                        <span>
                          {t("progress", { accepted, total: children.length })}
                        </span>
                        <progress
                          aria-label={t("progress", {
                            accepted,
                            total: children.length,
                          })}
                          max={Math.max(children.length, 1)}
                          value={accepted}
                        />
                      </span>
                      <ArrowRight size={15} />
                    </button>
                  );
                })}
            </div>
          ) : (
            <EmptyState>{t("empty")}</EmptyState>
          )}
        </>);
}
export function IntentColumn({intents,selectedIntentId,onSelect}:{intents:WorkIntent[];selectedIntentId?:string;onSelect:(id:string)=>void}) {
 const {t}=useTranslation("work");
 return (            <section className="work-intents">
              <h2>
                <Layers size={16} />
                {t("intents")} <span>{intents.length}</span>
              </h2>
              {intents.map((i) => (
                <button
                  key={i.id}
                  className={
                    "work-intent " + (i.id === selectedIntentId ? "is-selected" : "")
                  }
                  onClick={() => {
                    onSelect(i.id);
                  }}
                >
                  <span className="work-intent-title">{i.title}</span>
                  <WorkBadge value={i.state} />
                  <small>
                    {t(i.required ? "required" : "optional")} ·{" "}
                    {i.ownerId ?? "—"}
                  </small>
                </button>
              ))}
            </section>);
}
