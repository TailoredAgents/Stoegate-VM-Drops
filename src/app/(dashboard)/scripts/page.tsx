import { AudioLines, Braces } from "lucide-react";
import { db } from "@/lib/db";
import {
  createScriptAction,
  createScriptVersionAction,
  createVoiceAction,
} from "./actions";

const variables = [
  "first_name",
  "owner_name",
  "property_address",
  "street_name",
  "city",
  "state",
  "county",
  "postal_code",
  "acreage",
  "property_type",
];

export default async function ScriptsPage() {
  const [templates, voices] = await Promise.all([
    db.scriptTemplate.findMany({
      include: { versions: { orderBy: { version: "desc" } } },
      orderBy: { updatedAt: "desc" },
    }),
    db.voiceConfiguration.findMany({ orderBy: { name: "asc" } }),
  ]);
  return (
    <>
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Scripts & voices</h1>
        <p className="mt-1 text-sm text-slate-500">
          Reusable, versioned Handlebars messages and configurable ElevenLabs
          voices.
        </p>
      </div>
      <div className="mt-6 grid gap-5 xl:grid-cols-[1.3fr_1fr]">
        <section>
          <h2 className="mb-3 flex items-center gap-2 font-bold">
            <Braces className="h-4 w-4 text-emerald-700" />
            Script templates
          </h2>
          <div className="space-y-3">
            {templates.map((template) => {
              const latest = template.versions[0];
              return (
                <details className="card group p-5" key={template.id}>
                  <summary className="cursor-pointer list-none">
                    <div className="flex items-center justify-between">
                      <div>
                        <h3 className="font-semibold">{template.name}</h3>
                        <p className="mt-1 text-xs text-slate-500">
                          Version {latest?.version ?? 0} ·{" "}
                          {template.description || "No description"}
                        </p>
                      </div>
                      <span className="text-xs font-semibold text-emerald-700">
                        Edit / inspect
                      </span>
                    </div>
                    <p className="mt-3 line-clamp-2 text-sm leading-6 text-slate-600">
                      {latest?.body}
                    </p>
                  </summary>
                  <form
                    action={createScriptVersionAction}
                    className="mt-5 border-t border-slate-100 pt-5"
                  >
                    <input
                      type="hidden"
                      name="templateId"
                      value={template.id}
                    />
                    <label>
                      <span className="label">
                        Create version {(latest?.version ?? 0) + 1}
                      </span>
                      <textarea
                        className="textarea"
                        name="body"
                        defaultValue={latest?.body}
                        required
                      />
                    </label>
                    <button className="btn-primary mt-3" type="submit">
                      Save new version
                    </button>
                  </form>
                </details>
              );
            })}
            <details className="card p-5">
              <summary className="cursor-pointer font-semibold text-emerald-700">
                + Create script template
              </summary>
              <form action={createScriptAction} className="mt-4 space-y-4">
                <label>
                  <span className="label">Name</span>
                  <input className="input" name="name" required />
                </label>
                <label>
                  <span className="label">Description</span>
                  <input className="input" name="description" />
                </label>
                <label>
                  <span className="label">Template</span>
                  <textarea
                    className="textarea"
                    name="body"
                    required
                    placeholder="Hi {{#if first_name}}{{first_name}}{{else}}{{owner_name}}{{/if}}..."
                  />
                </label>
                <button className="btn-primary" type="submit">
                  Create script
                </button>
              </form>
            </details>
          </div>
        </section>
        <aside className="space-y-5">
          <div>
            <h2 className="mb-3 flex items-center gap-2 font-bold">
              <AudioLines className="h-4 w-4 text-emerald-700" />
              Voice configurations
            </h2>
            <div className="card divide-y divide-slate-100">
              {voices.map((voice) => (
                <div className="p-4" key={voice.id}>
                  <div className="flex items-center justify-between">
                    <p className="font-semibold">{voice.name}</p>
                    <span
                      className={`h-2 w-2 rounded-full ${voice.active ? "bg-emerald-500" : "bg-slate-300"}`}
                    />
                  </div>
                  <p className="mt-1 truncate font-mono text-xs text-slate-500">
                    {voice.voiceId}
                  </p>
                  <p className="mt-1 text-xs text-slate-500">{voice.modelId}</p>
                </div>
              ))}
            </div>
          </div>
          <details className="card p-5">
            <summary className="cursor-pointer font-semibold text-emerald-700">
              + Add voice
            </summary>
            <form action={createVoiceAction} className="mt-4 space-y-4">
              <label>
                <span className="label">Display name</span>
                <input className="input" name="name" required />
              </label>
              <label>
                <span className="label">ElevenLabs voice ID</span>
                <input className="input" name="voiceId" required />
              </label>
              <label>
                <span className="label">Model ID</span>
                <input
                  className="input"
                  name="modelId"
                  defaultValue="eleven_flash_v2_5"
                  required
                />
              </label>
              <button className="btn-primary" type="submit">
                Add voice
              </button>
            </form>
          </details>
          <div className="card p-5">
            <h3 className="text-sm font-bold">Supported variables</h3>
            <div className="mt-3 flex flex-wrap gap-2">
              {variables.map((variable) => (
                <code
                  className="rounded bg-slate-100 px-2 py-1 text-xs text-slate-700"
                  key={variable}
                >{`{{${variable}}}`}</code>
              ))}
            </div>
            <p className="mt-3 text-xs leading-5 text-slate-500">
              Use standard Handlebars conditionals such as{" "}
              <code>{`{{#if city}}...{{/if}}`}</code> to avoid broken messages.
            </p>
          </div>
        </aside>
      </div>
    </>
  );
}
