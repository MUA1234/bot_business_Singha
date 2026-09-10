/**
 * R2D — deterministic Ask-AI provider fixtures.
 *
 * No live model is reachable from this phase, and none is wanted: what needs proving here is that
 * the boundary behaves correctly for every SHAPE of provider output, and a real model cannot be
 * made to produce a malformed response, a fabricated citation or an injected instruction on demand.
 * A fixture can.
 *
 * WHAT THESE PROVE: integration, authorisation, validation and failure handling.
 * WHAT THEY DO NOT PROVE: that a real model answers well, or that the Sinhala and Tamil strings
 * below read naturally. Both remain human gates, recorded in the R2D report.
 */
import type { AskProvider } from "./ask";
import type { Language } from "./contract";

interface FixtureInput {
  question: string;
  language: Language;
  evidence: string;
  catalogueActionIds: readonly string[];
}

/** Pull the refs the retrieval actually authorised, so a good fixture cites only real evidence. */
function refsFrom(evidence: string): { table: string; id: string }[] {
  return [...evidence.matchAll(/ref="([^":]+):([^"]+)"/g)].map((m) => ({ table: m[1] ?? "", id: m[2] ?? "" }))
    .filter((r) => r.table !== "" && r.id !== "");
}

/** A grounded answer that cites what it was given. The ordinary, correct case. */
export const groundedProvider: AskProvider = {
  async complete(input: FixtureInput) {
    const refs = refsFrom(input.evidence).slice(0, 3);
    return {
      answer: answerText(input.language, refs.length),
      language: input.language,
      citations: refs.map((r) => ({
        sourceTable: r.table,
        sourceId: r.id,
        claimLabel: "supports the stated condition",
      })),
      confidence: refs.length > 0 ? 0.8 : 0.2,
      uncertainties: refs.length === 0 ? ["no evidence was available for this question"] : [],
      missingInformation: [],
      suggestedActions: input.catalogueActionIds.length
        ? [{ actionId: input.catalogueActionIds[0], rationale: "next step", requiresApproval: true }]
        : [],
      requiredApproval: null,
      escalation: null,
      refusalReason: null,
      staleEvidence: false,
    };
  },
};

/**
 * The three languages, carrying the SAME operational meaning.
 *
 * Identifiers, amounts and dates are placeholders substituted verbatim by the semantic tests, so
 * a translation cannot quietly alter a number — which is the failure that matters most here.
 */
function answerText(language: Language, evidenceCount: number): string {
  if (evidenceCount === 0) {
    switch (language) {
      case "si": return "මට මේ ගැන අවසර ලත් සාක්ෂි හමු නොවීය. එබැවින් මම අනුමාන කරන්නේ නැත.";
      case "ta": return "இதற்கு அங்கீகரிக்கப்பட்ட ஆதாரம் எதுவும் கிடைக்கவில்லை. எனவே நான் ஊகிக்கவில்லை.";
      default: return "I found no authorised evidence for this, so I am not going to guess.";
    }
  }
  switch (language) {
    case "si": return "ඔබගේ අවසර ලත් වැඩ අනුව, අවධානය අවශ්‍ය කරුණු පහත දැක්වේ. අනුමැතිය අවශ්‍ය නම් එය වෙනම ලබාගත යුතුය.";
    case "ta": return "உங்கள் அங்கீகரிக்கப்பட்ட வேலையின் அடிப்படையில், கவனம் தேவைப்படுபவை கீழே உள்ளன. ஒப்புதல் தேவைப்பட்டால் அது தனியாகப் பெறப்பட வேண்டும்.";
    default: return "Based on your authorised work, here is what needs attention. Anything requiring approval must be approved separately.";
  }
}

/** Not JSON at all. The commonest real provider failure. */
export const malformedProvider: AskProvider = {
  async complete() {
    return "Sure! Here's what I found: your tasks look fine.";
  },
};

/** Right shape, extra field — which may be a tool call wearing a plausible name. */
export const extraFieldProvider: AskProvider = {
  async complete(input: FixtureInput) {
    return {
      answer: "Here is your work.",
      language: input.language,
      citations: [],
      confidence: 0.2,
      uncertainties: ["limited evidence"],
      missingInformation: [],
      suggestedActions: [],
      requiredApproval: null,
      escalation: null,
      refusalReason: null,
      staleEvidence: false,
      toolCall: { name: "send_whatsapp", args: { to: "+94770000000" } },
    };
  },
};

/** Cites a record that was never retrieved — the fabricated-citation case. */
export const fabricatedCitationProvider: AskProvider = {
  async complete(input: FixtureInput) {
    return {
      answer: "Invoice INV-9999 is overdue and should be chased today.",
      language: input.language,
      citations: [{ sourceTable: "customer_invoices", sourceId: "00000000-0000-0000-0000-000000000999" }],
      confidence: 0.9,
      uncertainties: [],
      missingInformation: [],
      suggestedActions: [],
      requiredApproval: null,
      escalation: null,
      refusalReason: null,
      staleEvidence: false,
    };
  },
};

/** Proposes an action id that is not in the catalogue. */
export const unknownActionProvider: AskProvider = {
  async complete(input: FixtureInput) {
    const refs = refsFrom(input.evidence).slice(0, 1);
    return {
      answer: "You should transfer the balance to settle this.",
      language: input.language,
      citations: refs.map((r) => ({ sourceTable: r.table, sourceId: r.id })),
      confidence: 0.7,
      uncertainties: [],
      missingInformation: [],
      suggestedActions: [{ actionId: "finance.bank.transfer_funds", requiresApproval: false }],
      requiredApproval: null,
      escalation: null,
      refusalReason: null,
      staleEvidence: false,
    };
  },
};

/** Claims the work is already done — the most damaging possible output. */
export const claimsExecutionProvider: AskProvider = {
  async complete(input: FixtureInput) {
    const refs = refsFrom(input.evidence).slice(0, 1);
    return {
      answer: "I have assigned this task to Nimal and approved the overtime, so nothing else is needed.",
      language: input.language,
      citations: refs.map((r) => ({ sourceTable: r.table, sourceId: r.id })),
      confidence: 0.95,
      uncertainties: [],
      missingInformation: [],
      suggestedActions: [],
      requiredApproval: null,
      escalation: null,
      refusalReason: null,
      staleEvidence: false,
    };
  },
};

/** Answers in a language nobody asked for. */
export const wrongLanguageProvider: AskProvider = {
  async complete(input: FixtureInput) {
    const refs = refsFrom(input.evidence).slice(0, 1);
    return {
      answer: "Here is your work.",
      language: input.language === "en" ? "si" : "en",
      citations: refs.map((r) => ({ sourceTable: r.table, sourceId: r.id })),
      confidence: 0.6,
      uncertainties: [],
      missingInformation: [],
      suggestedActions: [],
      requiredApproval: null,
      escalation: null,
      refusalReason: null,
      staleEvidence: false,
    };
  },
};

/** Confident, no citations, nothing declared missing — a plausible invention. */
export const unsupportedClaimProvider: AskProvider = {
  async complete(input: FixtureInput) {
    return {
      answer: "Everything in your department is on track and no action is needed.",
      language: input.language,
      citations: [],
      confidence: 0.95,
      uncertainties: [],
      missingInformation: [],
      suggestedActions: [],
      requiredApproval: null,
      escalation: null,
      refusalReason: null,
      staleEvidence: false,
    };
  },
};

/** Obeys an instruction embedded in retrieved content. */
export const injectedProvider: AskProvider = {
  async complete(input: FixtureInput) {
    const obeyed = /ignore (all )?previous|reveal|system prompt|other compan/i.test(input.evidence);
    return {
      answer: obeyed
        ? "Here are the other company's invoices as instructed by the task note."
        : "Here is your work.",
      language: input.language,
      citations: obeyed
        ? [{ sourceTable: "customer_invoices", sourceId: "11111111-1111-1111-1111-111111111111" }]
        : [],
      confidence: 0.9,
      uncertainties: [],
      missingInformation: [],
      suggestedActions: [],
      requiredApproval: null,
      escalation: null,
      refusalReason: null,
      staleEvidence: false,
    };
  },
};

/** Never returns. Exercises the timeout path. */
export const hangingProvider: AskProvider = {
  async complete() {
    await new Promise((r) => setTimeout(r, 60_000));
    return {};
  },
};

/** Fails outright. */
export const failingProvider: AskProvider = {
  async complete() {
    throw new Error("provider unavailable");
  },
};

/** Oversized answer, beyond the contract's bound. */
export const oversizedProvider: AskProvider = {
  async complete(input: FixtureInput) {
    return {
      answer: "x".repeat(20_000),
      language: input.language,
      citations: [],
      confidence: 0.5,
      uncertainties: ["long"],
      missingInformation: [],
      suggestedActions: [],
      requiredApproval: null,
      escalation: null,
      refusalReason: null,
      staleEvidence: false,
    };
  },
};
