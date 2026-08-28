"use client";

import { useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/modal";
import { answerQuestion, type AnswerResult } from "./actions";
import { QUESTIONS, type QuestionKey } from "./questions";

export default function AskTheInstitutionPage() {
  const [selected, setSelected] = useState<QuestionKey | null>(null);
  const [answer, setAnswer] = useState<AnswerResult | null>(null);
  const [loading, setLoading] = useState(false);

  const ask = async (key: QuestionKey) => {
    setSelected(key);
    setLoading(true);
    setAnswer(null);
    try {
      const result = await answerQuestion(key);
      setAnswer(result);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-lg animate-[fade-in_0.3s_ease-out]">
      <div>
        <h1 className="text-2xl font-extrabold text-on-surface tracking-tight">Ask the Institution</h1>
        <p className="text-sm text-on-surface-variant mt-xs">
          Pick a question — every answer is computed from real data, with its source shown. Never a guess, never a fabricated number.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-sm">
        {QUESTIONS.map((q) => (
          <button
            key={q.key}
            onClick={() => ask(q.key)}
            className={`text-left px-lg py-md rounded-xl border transition-colors ${
              selected === q.key ? "border-secondary bg-secondary/5" : "border-outline-variant bg-surface-container-lowest hover:bg-surface-container-low"
            }`}
          >
            <span className="text-sm font-medium text-on-surface">{q.label}</span>
          </button>
        ))}
      </div>

      {selected && (
        <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-sm p-lg space-y-md">
          {loading ? (
            <div className="text-sm text-outline">Thinking...</div>
          ) : answer ? (
            <>
              <div className={`text-sm ${answer.insufficientData ? "text-outline italic" : "text-on-surface font-medium"}`}>{answer.answer}</div>

              {answer.supportingMetrics.length > 0 && (
                <div>
                  <div className="text-xs font-semibold text-outline uppercase tracking-wider mb-xs">Supporting Metrics</div>
                  <ul className="text-xs text-on-surface-variant space-y-xs list-disc list-inside">
                    {answer.supportingMetrics.map((m, i) => (
                      <li key={i}>{m}</li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="flex items-center justify-between pt-md border-t border-outline-variant">
                <span className="text-[11px] text-outline">Source: {answer.dataSource}</span>
                {answer.drillDownUrl && (
                  <Link href={answer.drillDownUrl}>
                    <Button size="sm" variant="outline">
                      Drill Down →
                    </Button>
                  </Link>
                )}
              </div>
            </>
          ) : null}
        </div>
      )}
    </div>
  );
}
