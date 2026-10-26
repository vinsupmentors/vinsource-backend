import fs from 'fs';
import path from 'path';
import prisma from '../config/database';
import { config } from '../config/env';
import { CALL_RECORDING_DIR } from '../middleware/upload';
import { storageService } from './storage.service';

/**
 * Transcription queue. Rows in CallTranscript are the queue: enqueue* creates/resets a PENDING row,
 * processPending() (run every minute from server.ts) takes them one at a time, sends the audio to the
 * free self-hosted Whisper service, then (optionally) asks a free LLM for a summary + action items.
 */

export const transcriptionEnabled = () => !!config.WHISPER_URL;

const MAX_ATTEMPTS = 3;
const STALE_PROCESSING_MS = 45 * 60 * 1000;

async function upsertPending(sourceType: 'CALL' | 'DEMO', sourceId: string, leadId: string | null, ownerId: string | null, reset = false) {
  const existing = await prisma.callTranscript.findUnique({ where: { sourceType_sourceId: { sourceType, sourceId } } });
  if (existing) {
    if (!reset && existing.status !== 'FAILED') return existing;
    return prisma.callTranscript.update({ where: { id: existing.id }, data: { status: 'PENDING', attempts: 0, error: null } });
  }
  return prisma.callTranscript.create({ data: { sourceType, sourceId, leadId, ownerId, status: 'PENDING' } });
}

/** Queue a phone-call recording. Safe to call repeatedly. */
export async function enqueueCallTranscript(callLogId: string, reset = false) {
  if (!transcriptionEnabled()) return null;
  const log = await prisma.leadCallLog.findUnique({ where: { id: callLogId }, select: { id: true, leadId: true, calledById: true } });
  if (!log) return null;
  return upsertPending('CALL', log.id, log.leadId, log.calledById, reset);
}

/** Queue the audio of an online demo (needs Demo.audioKey). */
export async function enqueueDemoTranscript(demoId: string, reset = false) {
  if (!transcriptionEnabled()) return null;
  const d = await prisma.demo.findUnique({ where: { id: demoId }, select: { id: true, leadId: true, conductedById: true, audioKey: true, lead: { select: { assignedToId: true } } } });
  if (!d || !d.audioKey) return null;
  return upsertPending('DEMO', d.id, d.leadId, d.conductedById || d.lead.assignedToId, reset);
}

async function loadAudio(sourceType: string, sourceId: string): Promise<{ data: Buffer; filename: string } | null> {
  if (sourceType === 'CALL') {
    const file = fs.existsSync(CALL_RECORDING_DIR) ? fs.readdirSync(CALL_RECORDING_DIR).find((f) => f.startsWith(`${sourceId}.`)) : undefined;
    if (!file) return null;
    return { data: fs.readFileSync(path.join(CALL_RECORDING_DIR, file)), filename: file };
  }
  const demo = await prisma.demo.findUnique({ where: { id: sourceId }, select: { audioKey: true } });
  if (!demo?.audioKey) return null;
  const url = await storageService.getPresignedUrl(config.R2_RECORDINGS_BUCKET, demo.audioKey, 900);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not download demo audio (${res.status})`);
  return { data: Buffer.from(await res.arrayBuffer()), filename: path.basename(demo.audioKey) };
}

interface WhisperResult { language?: string; duration?: number; text: string; segments: { start: number; end: number; text: string }[] }

async function callWhisper(audio: { data: Buffer; filename: string }): Promise<WhisperResult> {
  const headers: Record<string, string> = { 'Content-Type': 'application/octet-stream', 'X-Filename': audio.filename };
  if (config.WHISPER_TOKEN) headers.Authorization = `Bearer ${config.WHISPER_TOKEN}`;
  const res = await fetch(`${config.WHISPER_URL}/transcribe`, { method: 'POST', headers, body: audio.data as never });
  if (!res.ok) throw new Error(`Whisper service said ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as WhisperResult;
}

interface Summary { summary: string; actionItems: string[]; topics: string[] }

/** Optional free LLM pass (Google AI Studio free tier). Returns null when no key is set or the call fails. */
async function summarise(text: string, kind: 'CALL' | 'DEMO'): Promise<Summary | null> {
  if ((!config.OLLAMA_URL && !config.GEMINI_API_KEY) || text.trim().length < 40) return null;
  const prompt = `You are helping a training-institute sales manager. Below is the transcript of a ${kind === 'DEMO' ? 'live online demo class with a prospective student' : 'sales phone call with a prospective student'}. The speech is Tamil and/or English (possibly mixed). It may contain recognition errors.
Reply ONLY with JSON: {"summary": "3-5 sentence summary in English", "actionItems": ["short follow-up actions for the salesperson, in English"], "topics": ["up to 6 short topic tags such as fees, placement, course, timing, objection"]}.
Mention in the summary: the student's interest level, objections raised, and any commitments (dates, fees, next steps). Do not invent facts.

TRANSCRIPT:
${text.slice(0, 30000)}`;
  try {
    let raw = '';
    if (config.OLLAMA_URL) {
      // Local model — keep the context modest so small machines cope.
      const res = await fetch(`${config.OLLAMA_URL}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: config.OLLAMA_MODEL, prompt: prompt.slice(0, 24000), stream: false, format: 'json', options: { temperature: 0.2, num_ctx: 8192 } }),
      });
      if (!res.ok) { console.error('[transcribe] ollama request failed', res.status); return null; }
      raw = ((await res.json()) as { response?: string }).response || '';
    } else {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${config.GEMINI_MODEL}:generateContent?key=${encodeURIComponent(config.GEMINI_API_KEY)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseMimeType: 'application/json', temperature: 0.2 } }),
      });
      if (!res.ok) { console.error('[transcribe] summary request failed', res.status); return null; }
      const body = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
      raw = body.candidates?.[0]?.content?.parts?.[0]?.text || '';
    }
    const parsed = JSON.parse(raw.replace(/^```json\s*|```$/g, '')) as Partial<Summary>;
    const arr = (v: unknown) => (Array.isArray(v) ? v.map((x) => String(x).slice(0, 300)).slice(0, 10) : []);
    return { summary: String(parsed.summary || '').slice(0, 2000), actionItems: arr(parsed.actionItems), topics: arr(parsed.topics) };
  } catch (err) {
    console.error('[transcribe] summary failed:', err);
    return null;
  }
}

let running = false;

/** Takes up to `max` queued items. Called every minute; a second overlapping run is skipped. */
export async function processPending(max = 2): Promise<number> {
  if (!transcriptionEnabled() || running) return 0;
  running = true;
  let done = 0;
  try {
    // Rescue rows stuck in PROCESSING (server restarted mid-job).
    await prisma.callTranscript.updateMany({
      where: { status: 'PROCESSING', updatedAt: { lt: new Date(Date.now() - STALE_PROCESSING_MS) } },
      data: { status: 'PENDING' },
    });
    for (let i = 0; i < max; i++) {
      const row = await prisma.callTranscript.findFirst({ where: { status: 'PENDING', attempts: { lt: MAX_ATTEMPTS } }, orderBy: { createdAt: 'asc' } });
      if (!row) break;
      await prisma.callTranscript.update({ where: { id: row.id }, data: { status: 'PROCESSING', attempts: { increment: 1 } } });
      try {
        const audio = await loadAudio(row.sourceType, row.sourceId);
        if (!audio) throw new Error('Audio file not found');
        const w = await callWhisper(audio);
        const text = (w.text || '').trim();
        const sum = text ? await summarise(text, row.sourceType as 'CALL' | 'DEMO') : null;
        await prisma.callTranscript.update({
          where: { id: row.id },
          data: {
            status: 'DONE', text: text || '(no speech detected)', segments: w.segments as never, language: w.language || null,
            durationSec: w.duration ? Math.round(w.duration) : null,
            summary: sum?.summary || null, actionItems: (sum?.actionItems || []) as never, topics: (sum?.topics || []) as never,
            error: null, finishedAt: new Date(),
          },
        });
        // Put the AI summary on the lead as a note so it shows in the lead's Notes tab.
        if (sum?.summary && row.leadId) {
          const lines = [`AI ${row.sourceType === 'DEMO' ? 'demo' : 'call'} summary: ${sum.summary}`];
          if (sum.actionItems.length) lines.push('Action items:', ...sum.actionItems.map((a) => `• ${a}`));
          await prisma.leadNote.create({ data: { leadId: row.leadId, authorId: row.ownerId, body: lines.join('\n') } }).catch(() => {});
        }
        done++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[transcribe] failed', row.id, msg);
        await prisma.callTranscript.update({
          where: { id: row.id },
          data: { status: row.attempts + 1 >= MAX_ATTEMPTS ? 'FAILED' : 'PENDING', error: msg.slice(0, 1000) },
        });
      }
    }
  } finally {
    running = false;
  }
  return done;
}
