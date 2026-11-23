import { normalize } from "./text.ts";

/**
 * Fast, free first pass. Scores how much a piece of text looks like an instruction aimed at an
 * AI. It runs on every segment of every page, so it has to be cheap. It doesn't decide what's an
 * attack: it decides what's worth asking the model about.
 */

interface Rule {
  name: string;
  weight: number;
  pattern: RegExp;
}

const AI_NAMES = String.raw`(?:chat ?gpt|gpt-?\d|openai|claude|anthropic|gemini|bard|copilot|perplexity|llama|mistral|grok|deepseek)`;
const AI_WORDS = String.raw`(?:ai|a\.i\.|llm|large language model|language model|ai (?:assistant|agent|model|system|bot|summari[sz]er|crawler)|assistant|agent|chatbot|bot|model|summari[sz]er|crawler)`;

export const RULES: Rule[] = [
  {
    name: "speaks to AI",
    weight: 0.6,
    pattern: new RegExp(
      String.raw`\b(?:if you(?:'re| are) an? ${AI_WORDS}|(?:dear|attention|note (?:to|for)|message (?:to|for)|hey|hello|hi)[,:]? (?:any |all |the )?${AI_WORDS}s?|(?:any|all) ${AI_WORDS}s? (?:reading|processing|summari[sz]ing|visiting)|${AI_WORDS}s? (?:reading|processing|summari[sz]ing|browsing) this|to (?:the|any) ${AI_WORDS}s? (?:reading|that))|^\s*(?:(?:ai|llm)\s+)?(?:ai|llm|agent|assistant|model|bot)s?\s*[:,]|\b(?:ai|llm|agent|assistant|model)s? (?:instructions?|note|notice|task|directive)s?\b`,
      "i",
    ),
  },
  // Just naming an AI is common on normal pages ("Chat with Copilot"), so on its own it's not enough.
  { name: "names an AI", weight: 0.15, pattern: new RegExp(String.raw`\b${AI_NAMES}\b|\b(?:llm|language model|ai (?:assistant|agent|model|system))s?\b`, "i") },
  {
    name: "overrides instructions",
    weight: 0.6,
    pattern:
      /\b(?:ignore|disregard|forget|override|bypass|skip)\b[^.\n]{0,40}\b(?:instructions?|prompts?|rules|directions|guidelines|guardrails|context|system message|safety)\b|\b(?:ignore|disregard|forget)\b[^.\n]{0,12}\b(?:the|your) (?:user|human|operator)\b|\bnew (?:instructions?|rules|task)\b|\byou are now\b|\bfrom now on\b|\bsystem prompt\b|\bjailbreak\b/i,
  },
  {
    name: "fake system markup",
    weight: 0.55,
    pattern:
      /<\/?(?:system|instructions?|admin|prompt|sys)>|\[\/?INST\]|<\|im_start\|>|<\|im_end\|>|<<\/?SYS>>|#{2,}\s*(?:system|instructions?)\b|\b(?:system|admin|security) (?:override|update|notice|instruction)\b|\bbegin (?:system|new) (?:prompt|instructions?)\b|^\s*(?:system|assistant|human)\s*:/im,
  },
  {
    name: "keep it from the user",
    weight: 0.5,
    pattern:
      /\b(?:do not|don't|never|without)\b[^.\n]{0,20}\b(?:tell|telling|inform|informing|mention|mentioning|reveal|revealing|alert|alerting|notify|notifying|ask|asking|confirm|confirming)\b[^.\n]{0,15}\b(?:the )?(?:user|human|reader|operator|owner)\b|\b(?:silently|secretly|quietly|covertly)\b/i,
  },
  {
    name: "asks for secrets",
    weight: 0.5,
    pattern:
      /\b(?:send|email|e-mail|post|upload|forward|exfiltrate|leak|share|transmit|submit|include|append|paste|reveal|print|output)\b[^.\n]{0,60}\b(?:api[ _-]?keys?|passwords?|passcodes?|tokens?|cookies?|credentials?|secrets?|ssh keys?|private keys?|session|seed phrase|recovery phrase|chat history|conversation|system prompt|personal (?:data|information)|credit card|card number|otp|2fa code)\b/i,
  },
  { name: "data leak link", weight: 0.35, pattern: /!\[[^\]]*\]\(\s*https?:\/\/[^)\s]*[?&][^)\s]*=/i },
  {
    name: "wants money moved",
    weight: 0.5,
    pattern:
      /\bpaypal\.me\/|\bvenmo\.com\/|\bcash\.app\/|\bbuy\.stripe\.com\/|\b(?:send|transfer|wire|pay|donate)\b[^.\n]{0,30}(?:\$|usd|€|£|₹|\b\d[\d,.]*\s*(?:dollars|usd|btc|eth|usdc))|\b0x[a-f0-9]{40}\b|\bbc1[a-z0-9]{25,}\b|\b(?:card|payment method|wallet) on file\b|\bsaved (?:card|payment)\b|\bstored (?:card|payment)\b/i,
  },
  {
    name: "runs commands",
    weight: 0.55,
    pattern:
      /\brm\s+-[a-z]*r[a-z]*f|\bsudo\s+\S|\bcurl\b[^\n|]{0,120}\|\s*(?:ba)?sh\b|\bwget\s+https?:|\bpowershell\b|\binvoke-expression\b|\biex\s*\(|\bchmod\s+\+x\b|\bos\.system\(|\bsubprocess\.|\beval\(|\bdrop\s+table\b|\bmkfs\b|:\(\)\s*\{\s*:\|:&\s*\};:/i,
  },
  {
    name: "sends the agent elsewhere",
    weight: 0.3,
    pattern:
      /\b(?:navigate|go|visit|open|redirect|browse|click)\b[^.\n]{0,15}\b(?:to\s+)?(?:https?:\/\/\S+|the (?:following )?(?:link|url|page)|this (?:link|url|page)|\/admin\S*)/i,
  },
  {
    name: "bends the answer",
    weight: 0.35,
    pattern:
      /\b(?:when|while|if)\b[^.\n]{0,10}\b(?:summari[sz]ing|answering|responding|replying|describing|reviewing|ranking|recommending|asked)\b|\b(?:when|while|if)\b[^.\n]{0,25}\b(?:is|are|gets?) (?:described|summari[sz]ed|reviewed|translated|compared|ranked)\b|\b(?:rank|list|put|show)\b[^.\n]{0,30}\bfirst\b[^.\n]{0,15}\b(?:in|among)\b|\bin (?:your|the) (?:summary|answer|response|reply|review|output)\b|\b(?:always|only) (?:recommend|rank|rate|say|describe|mention)\b|\b(?:describe|rate|rank|call|present)\b[^.\n]{0,40}\bas (?:the best|the top|#1|number one|5 stars|five stars|excellent|trustworthy)\b/i,
  },
  {
    name: "orders the model",
    weight: 0.25,
    pattern:
      /\b(?:you must|you should|you will|you need to|you are required to|you have to|make sure (?:you|to)|be sure to|it is (?:very )?important (?:that|to)|important:|instruction:|task:)\b/i,
  },
  {
    name: "blocks the answer",
    weight: 0.3,
    pattern:
      /\b(?:do not|don't|never|refuse to)\b[^.\n]{0,10}\b(?:summari[sz]e|answer|respond|process|analy[sz]e|read|index|use) (?:this|the|any)\b|\brespond (?:only )?with\b|\breply (?:only )?with\b/i,
  },
];

export interface RuleScore {
  score: number;
  signals: string[];
}

/** Combines matched rule weights as independent evidence: 1 - Π(1 - w). */
export function scoreText(raw: string): RuleScore {
  const text = normalize(raw);
  if (!text) return { score: 0, signals: [] };
  let keep = 1;
  const signals: string[] = [];
  for (const rule of RULES) {
    if (rule.pattern.test(text)) {
      keep *= 1 - rule.weight;
      signals.push(rule.name);
    }
  }
  return { score: Math.round((1 - keep) * 1000) / 1000, signals };
}
