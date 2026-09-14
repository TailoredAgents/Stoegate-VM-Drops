import type { Metadata } from "next";
import { Braces, MessageSquareText, ShieldCheck } from "lucide-react";
import { SmsTemplateBodyEditor } from "@/components/sms-template-body-editor";
import { StatusBadge } from "@/components/status-badge";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { SMS_SEGMENT_LIMITS, SMS_TEMPLATE_FALLBACK_POLICY } from "@/lib/sms";
import {
  approveSmsTemplateVersionAction,
  createSmsTemplateAction,
  createSmsTemplateVersionAction,
  retireSmsTemplateVersionAction,
} from "./actions";

export const metadata: Metadata = { title: "SMS templates" };

export default async function SmsTemplatesPage() {
  const user = await requireUser();
  const templates = await db.smsTemplate.findMany({
    include: {
      createdBy: { select: { email: true } },
      versions: {
        orderBy: { version: "desc" },
        include: {
          createdBy: { select: { email: true } },
          approvedBy: { select: { email: true } },
        },
      },
    },
    orderBy: { updatedAt: "desc" },
  });

  return (
    <>
      <div>
        <p className="text-sm font-semibold text-emerald-700">
          Message governance
        </p>
        <h1 className="mt-1 text-3xl font-bold tracking-tight">
          SMS templates
        </h1>
        <p className="mt-1 max-w-3xl text-sm text-slate-500">
          Create immutable message versions, inspect representative encoding and
          segment estimates, and require admin approval before campaign use.
          Estimates never truncate the message and must be checked again after
          personalization.
        </p>
      </div>

      <div className="mt-6 grid gap-5 xl:grid-cols-[minmax(0,1.5fr)_minmax(300px,0.7fr)]">
        <section className="space-y-4">
          {templates.map((template) => {
            const latest = template.versions[0];
            return (
              <details className="card group p-5" key={template.id} open>
                <summary className="cursor-pointer list-none">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <h2 className="font-bold text-slate-950">
                        {template.name}
                      </h2>
                      <p className="mt-1 text-xs text-slate-500">
                        {template.description || "No description"} · created by{" "}
                        {template.createdBy.email}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <StatusBadge status={latest?.status ?? "DRAFT"} />
                      <span className="text-xs font-semibold text-emerald-700">
                        {template.versions.length} version
                        {template.versions.length === 1 ? "" : "s"}
                      </span>
                    </div>
                  </div>
                </summary>

                <div className="mt-5 space-y-3 border-t border-slate-100 pt-5">
                  {template.versions.map((version) => (
                    <article
                      className="rounded-lg border border-slate-200 p-4"
                      key={version.id}
                    >
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                          <p className="text-sm font-bold">
                            Version {version.version}
                          </p>
                          <p className="mt-1 text-xs text-slate-500">
                            {version.createdAt.toLocaleString()} ·{" "}
                            {version.createdBy.email} · hash{" "}
                            <code>{version.contentHash.slice(0, 12)}</code>
                          </p>
                          {version.approvedBy ? (
                            <p className="mt-1 text-xs text-slate-500">
                              Approved by {version.approvedBy.email} on{" "}
                              {version.approvedAt?.toLocaleString()}
                            </p>
                          ) : null}
                        </div>
                        <div className="flex flex-wrap gap-2">
                          <StatusBadge status={version.status} />
                          {user.role === "ADMIN" &&
                          version.status === "DRAFT" ? (
                            <form action={approveSmsTemplateVersionAction}>
                              <input
                                type="hidden"
                                name="versionId"
                                value={version.id}
                              />
                              <button className="btn-primary" type="submit">
                                <ShieldCheck className="h-4 w-4" /> Approve
                              </button>
                            </form>
                          ) : null}
                          {user.role === "ADMIN" &&
                          version.status !== "RETIRED" ? (
                            <form action={retireSmsTemplateVersionAction}>
                              <input
                                type="hidden"
                                name="versionId"
                                value={version.id}
                              />
                              <button className="btn-secondary" type="submit">
                                Retire
                              </button>
                            </form>
                          ) : null}
                        </div>
                      </div>
                      <p className="mt-3 whitespace-pre-wrap rounded-lg bg-slate-50 p-3 text-sm leading-6 text-slate-700">
                        {version.body}
                      </p>
                    </article>
                  ))}
                </div>

                <form
                  action={createSmsTemplateVersionAction}
                  className="mt-5 border-t border-slate-100 pt-5"
                >
                  <input type="hidden" name="templateId" value={template.id} />
                  <label>
                    <span className="label">
                      Create version {(latest?.version ?? 0) + 1}
                    </span>
                    <SmsTemplateBodyEditor defaultValue={latest?.body} />
                  </label>
                  <button className="btn-primary mt-3" type="submit">
                    Save draft version
                  </button>
                </form>
              </details>
            );
          })}

          {!templates.length ? (
            <div className="card p-8 text-center text-sm text-slate-500">
              No SMS templates yet. Create the first draft below.
            </div>
          ) : null}

          <details className="card p-5" open={!templates.length}>
            <summary className="cursor-pointer font-semibold text-emerald-700">
              + Create SMS template
            </summary>
            <form action={createSmsTemplateAction} className="mt-4 space-y-4">
              <label>
                <span className="label">Name</span>
                <input className="input" name="name" required />
              </label>
              <label>
                <span className="label">Description</span>
                <input className="input" name="description" />
              </label>
              <label>
                <span className="label">Draft message</span>
                <SmsTemplateBodyEditor />
              </label>
              <button className="btn-primary" type="submit">
                <MessageSquareText className="h-4 w-4" /> Create draft
              </button>
            </form>
          </details>
        </section>

        <aside className="space-y-5">
          <section className="card p-5">
            <h2 className="flex items-center gap-2 font-bold">
              <Braces className="h-4 w-4 text-emerald-700" /> Supported
              variables
            </h2>
            <div className="mt-4 space-y-3">
              {Object.entries(SMS_TEMPLATE_FALLBACK_POLICY).map(
                ([variable, fallback]) => (
                  <div key={variable}>
                    <code className="rounded bg-slate-100 px-2 py-1 text-xs text-slate-800">{`{{${variable}}}`}</code>
                    <p className="mt-1 text-xs leading-5 text-slate-500">
                      Fallback: {fallback}
                    </p>
                  </div>
                ),
              )}
            </div>
            <p className="mt-4 text-xs leading-5 text-slate-500">
              Optional fields can be wrapped in{" "}
              <code>{`{{#if city}}...{{/if}}`}</code>. Misspelled or unsupported
              variables are rejected when a version is saved and again before
              approval.
            </p>
          </section>

          <section className="card p-5">
            <h2 className="font-bold">Encoding and segment guidance</h2>
            <div className="mt-3 space-y-2 text-sm text-slate-600">
              <p>
                GSM-7: {SMS_SEGMENT_LIMITS.GSM_7.single} units for one segment,
                then {SMS_SEGMENT_LIMITS.GSM_7.concatenated} per segment.
              </p>
              <p>
                Unicode/UCS-2: {SMS_SEGMENT_LIMITS.UCS_2.single} units for one
                segment, then {SMS_SEGMENT_LIMITS.UCS_2.concatenated} per
                segment.
              </p>
              <p className="text-xs leading-5 text-slate-500">
                Some GSM-7 characters consume two units. Emoji and many smart
                punctuation characters switch the message to Unicode. Provider
                billing and final segmentation can differ, so inspect rendered
                campaign samples before approval.
              </p>
            </div>
          </section>

          {user.role !== "ADMIN" ? (
            <section className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
              You can create draft templates and versions. An admin must approve
              or retire a version.
            </section>
          ) : null}
        </aside>
      </div>
    </>
  );
}
