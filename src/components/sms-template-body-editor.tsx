"use client";

import { useMemo, useState } from "react";
import {
  estimateSmsSegments,
  renderSmsTemplate,
  validateSmsTemplate,
} from "@/lib/sms";

const sampleContext = {
  first_name: "Sam",
  owner_name: "Sam Owner",
  property_address: "1 Main St",
  street_name: "Main St",
  city: "Austin",
  state: "TX",
  county: "Travis",
  acreage: "2.5",
  property_type: "house",
};

export function SmsTemplateBodyEditor({
  defaultValue = "",
}: {
  defaultValue?: string;
}) {
  const [body, setBody] = useState(defaultValue);
  const preview = useMemo(() => {
    const validation = validateSmsTemplate(body);
    if (!validation.valid) return { error: validation.error } as const;
    try {
      const rendered = renderSmsTemplate(body, sampleContext);
      return {
        rendered,
        analysis: estimateSmsSegments(rendered),
      } as const;
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : "Invalid template",
      } as const;
    }
  }, [body]);

  return (
    <div>
      <textarea
        className="textarea min-h-36"
        name="body"
        value={body}
        onChange={(event) => setBody(event.target.value)}
        placeholder="Hi {{first_name}}, are you open to an offer for {{property_address}}?"
        required
      />
      {"error" in preview ? (
        <p className="mt-2 text-xs font-medium text-rose-700">
          {preview.error}
        </p>
      ) : (
        <div className="mt-3 rounded-lg bg-slate-50 p-3">
          <p className="text-xs font-semibold text-slate-500">
            Representative preview
          </p>
          <p className="mt-1 whitespace-pre-wrap text-sm text-slate-800">
            {preview.rendered}
          </p>
          <p className="mt-2 text-xs text-slate-500">
            {preview.analysis.encoding.replace("_", "-")} ·{" "}
            {preview.analysis.characterCount.toLocaleString()} characters ·{" "}
            {preview.analysis.encodingUnitCount.toLocaleString()} encoding units
            · {preview.analysis.segmentCount.toLocaleString()} estimated segment
            {preview.analysis.segmentCount === 1 ? "" : "s"}
          </p>
          {preview.analysis.warnings.map((warning) => (
            <p className="mt-1 text-xs text-amber-700" key={warning.code}>
              {warning.message}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
