/**
 * Thin wrapper around the LiveKit server SDK — the ONLY file in this codebase
 * that touches LIVEKIT_API_KEY/LIVEKIT_API_SECRET. Nothing downstream of
 * this module ever sees those credentials; controllers call these functions
 * and hand the caller back either a short-lived per-participant JWT (join)
 * or nothing at all (host-control actions, which this service executes
 * server-side against LiveKit's Room Service API).
 *
 * Host privileges (mute/remove/disable-camera) are deliberately NOT encoded
 * as elevated grants inside the participant's own access token — every
 * participant's token carries the same ordinary room-join grant. A trainer
 * "acts as host" only by calling our own backend endpoints (gated by
 * TrainerAssignment / LIVE_CLASSES module access), which then call the
 * LiveKit Room Service API using this service's credentials. The frontend
 * never gets admin-level LiveKit power directly — see spec section 47.
 */
import {
  AccessToken, RoomServiceClient, EgressClient, WebhookReceiver,
  EncodedFileType, type VideoGrant,
} from 'livekit-server-sdk';
import { config } from '../config/env';
import { AppError } from '../middleware/errorHandler';

function isConfigured(): boolean {
  return !!(config.LIVEKIT_URL && config.LIVEKIT_API_KEY && config.LIVEKIT_API_SECRET);
}

function assertConfigured(): void {
  if (!isConfigured()) {
    throw new AppError(
      'Live Classes video infrastructure is not set up yet. Ask an admin to configure LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET on the server.',
      503
    );
  }
}

/** The browser connects to the wss:// URL directly; the Room Service (server-to-server) API is plain HTTP(S). */
function httpUrl(): string {
  return config.LIVEKIT_URL.replace(/^wss:\/\//, 'https://').replace(/^ws:\/\//, 'http://');
}

let _roomService: RoomServiceClient | null = null;
function roomService(): RoomServiceClient {
  assertConfigured();
  if (!_roomService) {
    _roomService = new RoomServiceClient(httpUrl(), config.LIVEKIT_API_KEY, config.LIVEKIT_API_SECRET);
  }
  return _roomService;
}

/** True once an admin has actually filled in the three env vars — used to give a clear "not set up yet" UI instead of a 500. */
export function isLiveKitConfigured(): boolean {
  return isConfigured();
}

/** The wss:// URL the frontend's LiveKit client SDK should connect to. */
export function getLiveKitUrl(): string {
  assertConfigured();
  return config.LIVEKIT_URL;
}

/**
 * Mints a short-lived (4h) per-participant access token. `identity` MUST be
 * the platform's own User.id (never anything guessable) so server-side
 * host-control calls (which address participants by identity) reliably hit
 * the right person, and so a disconnect/reconnect resolves to the same
 * LiveClassParticipant bookkeeping.
 */
export async function mintAccessToken(opts: { roomName: string; identity: string; name: string; metadata?: string }): Promise<string> {
  assertConfigured();
  const at = new AccessToken(config.LIVEKIT_API_KEY, config.LIVEKIT_API_SECRET, {
    identity: opts.identity,
    name: opts.name,
    metadata: opts.metadata,
    ttl: '4h',
  });
  const grant: VideoGrant = {
    roomJoin: true,
    room: opts.roomName,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
  };
  at.addGrant(grant);
  return at.toJwt();
}

/** Idempotent — called from /start. A room that already exists (e.g. a trainer double-clicking Start) is left as-is. */
export async function ensureRoom(roomName: string): Promise<void> {
  const svc = roomService();
  try {
    await svc.createRoom({ name: roomName, emptyTimeout: 30 * 60, maxParticipants: 100 });
  } catch {
    // Already exists — fine.
  }
}

/** Called from /end. Disconnects anyone still connected and frees the room. Safe to call on a room that's already gone. */
export async function closeRoom(roomName: string): Promise<void> {
  if (!isConfigured()) return; // nothing to close if it was never set up
  try {
    await roomService().deleteRoom(roomName);
  } catch {
    // Already gone / never created — fine.
  }
}

export interface LiveParticipantInfo {
  identity: string;
  name: string;
  joinedAt: number;
  audioMuted: boolean;
  videoMuted: boolean;
}

/** Live snapshot straight from LiveKit — used to overlay real mic/camera state on top of our own DB participant rows. */
export async function listLiveParticipants(roomName: string): Promise<LiveParticipantInfo[]> {
  if (!isConfigured()) return [];
  try {
    const participants = await roomService().listParticipants(roomName);
    return participants.map((p: (typeof participants)[number]) => {
      const tracks = p.tracks || [];
      // LiveKit's TrackType protobuf enum is AUDIO=0 / VIDEO=1 — checked
      // defensively against both the numeric and string form since the
      // exact re-export shape can shift between SDK minor versions.
      const audioTrack = tracks.find((t: any) => t.type === 0 || t.type === 'AUDIO');
      const videoTrack = tracks.find((t: any) => t.type === 1 || t.type === 'VIDEO');
      return {
        identity: p.identity,
        name: p.name || p.identity,
        joinedAt: Number(p.joinedAt) || 0,
        audioMuted: audioTrack ? !!audioTrack.muted : true,
        videoMuted: videoTrack ? !!videoTrack.muted : true,
      };
    });
  } catch {
    return [];
  }
}

/** Host action: force-mute a participant's mic or camera. Safe no-op if they have no such track published. */
export async function setParticipantTrackMuted(roomName: string, identity: string, kind: 'audio' | 'video', muted: boolean): Promise<void> {
  const svc = roomService();
  const participants = await svc.listParticipants(roomName).catch(() => []);
  const p = participants.find((x: (typeof participants)[number]) => x.identity === identity);
  if (!p) return;
  const wantType = kind === 'audio' ? 0 : 1;
  const wantTypeStr = kind === 'audio' ? 'AUDIO' : 'VIDEO';
  for (const track of p.tracks || []) {
    if ((track as any).type === wantType || (track as any).type === wantTypeStr) {
      await svc.mutePublishedTrack(roomName, identity, track.sid, muted);
    }
  }
}

/** Host action: disconnect a participant from the room entirely. */
export async function removeParticipant(roomName: string, identity: string): Promise<void> {
  const svc = roomService();
  await svc.removeParticipant(roomName, identity).catch(() => {
    // Already left on their own — fine.
  });
}

// ── Recording (Phase 2) — self-hosted LiveKit Egress → private R2 bucket ───────
// Requires a Redis instance shared between the LiveKit server and its Egress
// worker (see ../../../livekit/README.md "Recording setup") — without it,
// Egress simply never picks up the request and startEgress below will throw,
// which callers treat as best-effort (a recording failure never blocks a
// class from starting/ending).

function isRecordingConfigured(): boolean {
  return isConfigured() && !!(config.R2_ACCOUNT_ID && config.R2_ACCESS_KEY_ID && config.R2_SECRET_ACCESS_KEY && config.R2_ENDPOINT && config.R2_RECORDINGS_BUCKET);
}

export function isLiveKitRecordingConfigured(): boolean {
  return isRecordingConfigured();
}

let _egressClient: EgressClient | null = null;
function egressClient(): EgressClient {
  assertConfigured();
  if (!_egressClient) {
    _egressClient = new EgressClient(httpUrl(), config.LIVEKIT_API_KEY, config.LIVEKIT_API_SECRET);
  }
  return _egressClient;
}

/**
 * Starts a room-composite (grid layout) recording, uploaded directly by the
 * Egress worker to the private recordings bucket — this server never touches
 * the video bytes themselves, only the resulting object key. Returns null
 * (rather than throwing) when recording isn't configured, so callers can
 * treat "no recording" as a normal, expected outcome rather than an error.
 */
export async function startEgress(roomName: string, liveClassId: string): Promise<{ egressId: string } | null> {
  if (!isRecordingConfigured()) return null;
  const filepath = `recordings/${liveClassId}/${Date.now()}.mp4`;
  const info = await egressClient().startRoomCompositeEgress(
    roomName,
    {
      file: {
        fileType: EncodedFileType.MP4,
        filepath,
        output: {
          case: 's3',
          value: {
            accessKey: config.R2_ACCESS_KEY_ID,
            secret: config.R2_SECRET_ACCESS_KEY,
            bucket: config.R2_RECORDINGS_BUCKET,
            endpoint: config.R2_ENDPOINT,
            region: 'auto',
            forcePathStyle: true,
          },
        },
      },
    } as any, // EncodedFileOutput's exact protobuf-ts shape can drift by SDK minor version — see note in package README
    { layout: 'grid' }
  );
  return { egressId: info.egressId };
}

/** Best-effort — a recording that fails to stop cleanly still gets picked up by the `egress_ended` webhook once LiveKit notices the room closed. */
export async function stopEgress(egressId: string): Promise<void> {
  if (!isConfigured()) return;
  await egressClient().stopEgress(egressId).catch(() => {});
}

let _webhookReceiver: WebhookReceiver | null = null;
/** Verifies + parses an inbound LiveKit webhook (egress_ended, etc.) — the RAW request body is required for signature verification, so the route registering this must NOT run express.json() first (see app.ts). */
export function verifyWebhook(rawBody: string, authHeader: string | undefined) {
  assertConfigured();
  if (!_webhookReceiver) {
    _webhookReceiver = new WebhookReceiver(config.LIVEKIT_API_KEY, config.LIVEKIT_API_SECRET);
  }
  return _webhookReceiver.receive(rawBody, authHeader);
}
