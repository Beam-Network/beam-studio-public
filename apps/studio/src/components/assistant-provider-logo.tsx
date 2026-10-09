import ai21Logo from "@lobehub/icons-static-svg/icons/ai21-brand-color.svg";
import anthropicLogo from "@lobehub/icons-static-svg/icons/anthropic.svg";
import awsLogo from "@lobehub/icons-static-svg/icons/aws-color.svg";
import cohereLogo from "@lobehub/icons-static-svg/icons/cohere-color.svg";
import deepseekLogo from "@lobehub/icons-static-svg/icons/deepseek-color.svg";
import geminiLogo from "@lobehub/icons-static-svg/icons/gemini-color.svg";
import groqLogo from "@lobehub/icons-static-svg/icons/groq.svg";
import inflectionLogo from "@lobehub/icons-static-svg/icons/inflection.svg";
import metaLogo from "@lobehub/icons-static-svg/icons/meta-color.svg";
import microsoftLogo from "@lobehub/icons-static-svg/icons/microsoft-color.svg";
import minimaxLogo from "@lobehub/icons-static-svg/icons/minimax-color.svg";
import mistralLogo from "@lobehub/icons-static-svg/icons/mistral-color.svg";
import moonshotLogo from "@lobehub/icons-static-svg/icons/moonshot.svg";
import nousResearchLogo from "@lobehub/icons-static-svg/icons/nousresearch.svg";
import nvidiaLogo from "@lobehub/icons-static-svg/icons/nvidia-color.svg";
import openaiLogo from "@lobehub/icons-static-svg/icons/openai.svg";
import openrouterLogo from "@lobehub/icons-static-svg/icons/openrouter-color.svg";
import perplexityLogo from "@lobehub/icons-static-svg/icons/perplexity-color.svg";
import qwenLogo from "@lobehub/icons-static-svg/icons/qwen-color.svg";
import xaiLogo from "@lobehub/icons-static-svg/icons/xai.svg";
import zaiLogo from "@lobehub/icons-static-svg/icons/zai.svg";
import zeroOneLogo from "@lobehub/icons-static-svg/icons/zeroone-color.svg";
import { cn } from "@/lib/utils";

type ProviderLogo = {
  label: string;
  monochrome?: boolean;
  src: string;
};

const PROVIDER_LOGOS: Record<string, ProviderLogo> = {
  "01-ai": { label: "01.AI", src: zeroOneLogo },
  ai21: { label: "AI21", src: ai21Logo },
  amazon: { label: "Amazon", src: awsLogo },
  anthropic: { label: "Anthropic", monochrome: true, src: anthropicLogo },
  cohere: { label: "Cohere", src: cohereLogo },
  deepseek: { label: "DeepSeek", src: deepseekLogo },
  google: { label: "Google Gemini", src: geminiLogo },
  groq: { label: "Groq", monochrome: true, src: groqLogo },
  inflection: { label: "Inflection", monochrome: true, src: inflectionLogo },
  meta: { label: "Meta", src: metaLogo },
  microsoft: { label: "Microsoft", src: microsoftLogo },
  minimax: { label: "MiniMax", src: minimaxLogo },
  mistral: { label: "Mistral AI", src: mistralLogo },
  moonshot: { label: "Moonshot AI", monochrome: true, src: moonshotLogo },
  nousresearch: {
    label: "Nous Research",
    monochrome: true,
    src: nousResearchLogo,
  },
  nvidia: { label: "NVIDIA", src: nvidiaLogo },
  openai: { label: "OpenAI", monochrome: true, src: openaiLogo },
  openrouter: { label: "OpenRouter", src: openrouterLogo },
  perplexity: { label: "Perplexity", src: perplexityLogo },
  qwen: { label: "Qwen", src: qwenLogo },
  xai: { label: "xAI", monochrome: true, src: xaiLogo },
  zai: { label: "Z.ai", monochrome: true, src: zaiLogo },
};

const PROVIDER_ALIASES: Record<string, string> = {
  "amazon-bedrock": "amazon",
  "google-vertex": "google",
  "meta-llama": "meta",
  "mistral-ai": "mistral",
  mistralai: "mistral",
  moonshotai: "moonshot",
  "nous-research": "nousresearch",
  "x-ai": "xai",
  "z-ai": "zai",
};

function normalizeProviderId(value: string | undefined) {
  const normalized = value?.trim().toLowerCase() ?? "";
  return PROVIDER_ALIASES[normalized] ?? normalized;
}

function modelProviderId(modelId: string, configuredProviderId?: string) {
  const normalizedModel = modelId.trim().toLowerCase();
  const modelPrefix = normalizeProviderId(normalizedModel.split("/")[0]);
  if (normalizedModel.includes("/") && PROVIDER_LOGOS[modelPrefix]) {
    return modelPrefix;
  }

  if (/^(gpt-|chatgpt-|o[134](?:-|$)|codex)/.test(normalizedModel)) {
    return "openai";
  }
  if (/^(claude|anthropic)/.test(normalizedModel)) return "anthropic";
  if (/^(gemini|gemma|google)/.test(normalizedModel)) return "google";
  if (/^(grok|xai)/.test(normalizedModel)) return "xai";
  if (/^deepseek/.test(normalizedModel)) return "deepseek";
  if (
    /^(mistral|ministral|codestral|magistral|pixtral)/.test(normalizedModel)
  ) {
    return "mistral";
  }
  if (/^(command-|cohere)/.test(normalizedModel)) return "cohere";
  if (/^(qwen|qwq)/.test(normalizedModel)) return "qwen";

  return normalizeProviderId(configuredProviderId);
}

export function AssistantProviderLogo({
  className,
  modelId,
  providerId,
}: {
  className?: string;
  modelId: string;
  providerId?: string;
}) {
  const resolvedProviderId = modelProviderId(modelId, providerId);
  const logo = PROVIDER_LOGOS[resolvedProviderId];

  if (!logo) {
    const fallback =
      (resolvedProviderId || modelId)
        .split(/[-_/.\s]+/)
        .filter(Boolean)
        .map((part) => part[0])
        .join("")
        .slice(0, 2)
        .toUpperCase() || "AI";
    return (
      <span
        aria-hidden="true"
        className={cn(
          "grid size-5 shrink-0 place-items-center rounded-control-compact bg-secondary text-[9px] font-semibold text-secondary-foreground",
          className,
        )}
      >
        {fallback}
      </span>
    );
  }

  return (
    <img
      alt=""
      aria-label={logo.label}
      className={cn(
        "size-5 shrink-0 object-contain",
        logo.monochrome && "dark:invert",
        className,
      )}
      src={logo.src}
      title={logo.label}
    />
  );
}
