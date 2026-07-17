import { resolveMimoStyleInstruction } from '../../lib/tts/mimo-style';
import { annotateForMimo } from '../../lib/tts/mimo-annotate';
import { splitIntoSentences } from '../../lib/tts/sentence-split';
import { useAIStore } from '../../store/ai';
import { useScriptStore } from '../../store/script';
import type { AISettings, TTSProvider, TTSVoicePreset } from '../../types/ai';
import { workflowSession } from './session';

interface MimoSpeechInput {
  styleInstruction?: string;
  sentences?: Array<{ subtitle: string; speak: string }>;
}

async function buildMimoSpeechInput(
  scriptText: string,
  settings: AISettings,
): Promise<MimoSpeechInput> {
  const templateId = useScriptStore.getState().selectedTemplate;
  const templates = useAIStore.getState().userPromptEntries['script-template'] ?? [];
  const template = templates.find((item) => item.id === templateId);
  const clean = splitIntoSentences(scriptText);
  const styleInstruction = resolveMimoStyleInstruction(template);
  if (clean.length === 0) return { styleInstruction };
  const tags = await annotateForMimo(clean, template?.ttsAnnotateHint ?? '', settings);
  return {
    styleInstruction,
    sentences: clean.map((subtitle, index) => ({
      subtitle,
      speak: tags[index] ? `(${tags[index]})${subtitle}` : subtitle,
    })),
  };
}

function resolveVoice(voice: TTSVoicePreset | null): TTSVoicePreset | undefined {
  if (!voice) return undefined;
  const autoVoiceId = workflowSession.autoParams?.voiceId;
  return {
    ...voice,
    voiceId: autoVoiceId && voice.providerType === 'minimax'
      ? autoVoiceId
      : voice.voiceId,
  };
}

interface BuildTTSRequestOptions {
  requestId: string;
  scriptText: string;
  projectDir: string;
  provider: TTSProvider | null;
  voice: TTSVoicePreset | null;
  settings: AISettings;
}

export async function buildTTSRequest(options: BuildTTSRequestOptions) {
  const mimo = options.provider?.type === 'xiaomi_mimo'
    ? await buildMimoSpeechInput(options.scriptText, options.settings)
    : {};
  return {
    requestId: options.requestId,
    text: options.scriptText,
    provider: options.provider ?? undefined,
    voice: resolveVoice(options.voice),
    styleInstruction: mimo.styleInstruction,
    sentences: mimo.sentences,
    projectDir: options.projectDir,
    telemetryRunId: workflowSession.telemetryRunId,
  };
}
