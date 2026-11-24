/* ============================================================
   The board page's state, expressed without a view framework.

   Everything board.html used to hold in module-level `let`s — the live board,
   which chapter is open, whether the map is up, whether the camera is
   following steps, where the narrator's playhead sits, whether a replay is
   running — lives here as one plain, immutable value.

   Pure selectors sit beside the types so any view layer (React today, Foldkit
   later) and any test in Node can ask the same questions: which surface is on
   screen, which step is lit, what the tape contains, and which rail rows are
   heard, now, or ahead.
   ============================================================ */

import type {
  Board,
  Chapter,
  LogEntry,
} from '../../../../src/board/state.js';
import type {
  Bounds,
  Box,
  Point,
  Size,
  View,
} from '../../../../src/board/camera.js';
import { boardMap, type BoardMap } from '../../../../src/board/map.js';
import { groupRuns, lineStates, type GroupRun, type LineState } from '../../../../src/board/script.js';
import { railMarks, tapeOf, type RailMark, type Section } from '../../../../src/board/tape.js';

export type LinkStatus = 'live' | 'idle' | 'down';

export type SavingStatus =
  | { readonly saving: true }
  | { readonly saving: false, readonly why: string };

export type VoiceInfo = {
  readonly name: string,
  readonly lang: string,
  readonly local: boolean,
};

export type Caption = {
  readonly text: string,
  readonly problem: boolean,
};

/** Index into `board.chapters`, or `null` for the live chapter. */
export type ChapterRef = number | null;

export type CameraState = {
  readonly view: View,
  readonly smooth: boolean,
  readonly userMoved: boolean,
  readonly following: boolean,
  readonly stage: Size,
  readonly canvas: Size,
  readonly boxes: Readonly<Record<string, Box>>,
  readonly offset: Point,
  readonly stepsBarHeight: number,
};

export type PlaybackState = {
  /** Whether speech synthesis is available in this host. */
  readonly narratorAvailable: boolean,
  /** True when the tape covers the whole board (started from the map). */
  readonly tapeWhole: boolean,
  /** Sections currently on the tape, built by `tapeOf`. */
  readonly tape: readonly Section[],
  readonly tapePlaying: boolean,
  /** Current section index in `tape`, or -1 before the tape has started. */
  readonly tapeIndex: number,
  /** True after the tape ran to its end, so the next play starts from 0. */
  readonly tapeEnded: boolean,
  readonly wordOffset: number | null,
  /** Playback rate, clamped to [0.5, 2.5]. */
  readonly rate: number,
  readonly voice: string | null,
  readonly voices: readonly VoiceInfo[],
  /** Silent flow-stepping timer, active when the narrator is not driving. */
  readonly flowPlaying: boolean,
};

export type ReplayState = {
  readonly active: boolean,
  readonly board: Board | null,
  /** Index of an amended chapter the replay has stepped back into, or null. */
  readonly chapterAt: number | null,
  readonly entries: readonly LogEntry[],
  readonly index: number,
};

export type Model = {
  readonly board: Board | null,
  readonly viewing: ChapterRef,
  /** Local active step while reading a finished chapter; live chapter uses `board.active`. */
  readonly chapterStep: number | null,
  /** Chapters updated while the reader was looking elsewhere (`null` = live chapter). */
  readonly changed: readonly ChapterRef[],
  readonly mapOpen: boolean,

  readonly link: LinkStatus,
  readonly saving: SavingStatus,
  readonly exported: boolean,
  readonly chapterOnly: boolean,
  readonly boardTag: string | null,

  readonly camera: CameraState,
  readonly playback: PlaybackState,
  readonly replay: ReplayState,

  readonly railOpen: boolean,
  readonly exportMenuOpen: boolean,
  readonly caption: Caption | null,
};

export type InitOptions = {
  readonly following?: boolean,
  readonly voice?: string | null,
  readonly rate?: number,
  readonly narratorAvailable?: boolean,
  readonly voices?: readonly VoiceInfo[],
  readonly railOpen?: boolean,
  readonly exported?: boolean,
  readonly chapterOnly?: boolean,
  readonly boardTag?: string | null,
  readonly stage?: Size,
  readonly stepsBarHeight?: number,
};

export const FLOW_TICK_MS = 1600;
export const MIN_RATE = 0.5;
export const MAX_RATE = 2.5;
export const MIN_ZOOM = 0.2;
export const MAX_ZOOM = 3;

export function clampRate(value: number): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 1;
  return Math.max(MIN_RATE, Math.min(MAX_RATE, Number(n.toFixed(2))));
}

export function init(options: InitOptions = {}): Model {
  const exported = options.exported ?? false;
  return {
    board: null,
    viewing: null,
    chapterStep: null,
    changed: [],
    mapOpen: false,

    link: exported ? 'idle' : 'down',
    saving: { saving: true },
    exported,
    chapterOnly: options.chapterOnly ?? false,
    boardTag: options.boardTag ?? null,

    camera: {
      view: { x: 0, y: 0, k: 1 },
      smooth: false,
      userMoved: false,
      following: options.following ?? true,
      stage: options.stage ?? { w: 0, h: 0 },
      canvas: { w: 0, h: 0 },
      boxes: {},
      offset: { x: 0, y: 0 },
      stepsBarHeight: options.stepsBarHeight ?? 54,
    },

    playback: {
      narratorAvailable: options.narratorAvailable ?? false,
      tapeWhole: false,
      tape: [],
      tapePlaying: false,
      tapeIndex: -1,
      tapeEnded: false,
      wordOffset: null,
      rate: clampRate(options.rate ?? 1),
      voice: options.voice ?? null,
      voices: options.voices ?? [],
      flowPlaying: false,
    },

    replay: {
      active: false,
      board: null,
      chapterAt: null,
      entries: [],
      index: 0,
    },

    railOpen: options.railOpen ?? true,
    exportMenuOpen: false,
    caption: null,
  };
}

/** The surface currently on screen, with its effective `active` step. */
export function currentSurface(model: Model): Board | Chapter | null {
  if (model.replay.active && model.replay.board) {
    const back = model.replay.chapterAt == null
      ? null
      : (model.replay.board.chapters[model.replay.chapterAt] ?? null);
    return back ? { ...back, active: null } : model.replay.board;
  }
  if (!model.board) return null;
  if (model.viewing == null) return model.board;
  const ch = model.board.chapters[model.viewing];
  return ch ? { ...ch, active: model.chapterStep } : model.board;
}

export function activeStep(model: Model): number | null {
  return currentSurface(model)?.active ?? null;
}

/** Whether the narrator owns playback (hiding the silent flow-timer button). */
export function narratorDrives(model: Model): boolean {
  return model.playback.narratorAvailable && model.playback.tape.length > 0;
}

/** The tape sections for the current scope and surface, built via `tapeOf`. */
export function computeTape(model: Model): Section[] {
  return tapeOf(model.board, {
    whole: model.playback.tapeWhole && !model.replay.active,
    surface: currentSurface(model),
    viewing: model.viewing,
  });
}

export function currentLineStates(model: Model): LineState[] {
  return lineStates(currentSurface(model) ?? undefined);
}

export function currentGroupRuns(model: Model): GroupRun[] {
  return groupRuns(currentSurface(model) ?? undefined);
}

export function currentRailMarks(model: Model): RailMark[] {
  const rows = currentSurface(model)?.transcript.length ?? 0;
  return railMarks([...model.playback.tape], model.playback.tapeIndex, model.viewing, rows);
}

export function currentMap(model: Model): BoardMap {
  return boardMap(model.board);
}

/** Visible area of the stage in screen pixels, excluding the floating steps bar. */
export function visibleArea(model: Model): Bounds {
  const hasSteps = (currentSurface(model)?.flow.length ?? 0) > 0;
  const inset = hasSteps ? model.camera.stepsBarHeight : 0;
  return {
    x0: 0,
    y0: 0,
    x1: model.camera.stage.w,
    y1: model.camera.stage.h - inset,
  };
}

/** Warning text when the board is not being saved to disk, or `null` when healthy. */
export function unsavedWarning(model: Model): string | null {
  if (model.saving.saving || model.saving.why === 'memory') return null;
  return model.saving.why === 'other-server'
    ? 'another spiega owns this board\u2019s file \u2014 nothing drawn here will survive a restart'
    : 'this board\u2019s file could not be opened \u2014 nothing drawn here will survive a restart';
}

/** Parse `#2` into chapter index `1`, or `null` for live / invalid hashes. */
export function chapterFromHash(board: Board | null, hash: string | undefined): number | null {
  if (!board || !hash) return null;
  const n = Number(hash.replace(/^#/, ''));
  return Number.isInteger(n) && n >= 1 && n <= board.chapters.length ? n - 1 : null;
}

/**
 * The log as a replay walks it: skips `focus` and `clear`, and coalesces
 * consecutive `amend` ops aimed at the same chapter into one visit.
 */
export function replayEntries(log: readonly LogEntry[]): LogEntry[] {
  const out: LogEntry[] = [];
  for (const e of log) {
    if (e.op === 'focus' || e.op === 'clear') continue;
    const prev = out[out.length - 1];
    if (e.op === 'amend' && prev && prev.op === 'amend' && prev.chapter === e.chapter) {
      const prevOps = Array.isArray(prev.ops) ? prev.ops : [prev.ops];
      const nextOps = Array.isArray(e.ops) ? e.ops : [e.ops];
      out[out.length - 1] = { ...prev, ops: [...prevOps, ...nextOps] };
      continue;
    }
    if (e.op === 'amend') {
      const ops = Array.isArray(e.ops) ? [...e.ops] : [e.ops];
      out.push({ ...e, ops });
    } else {
      out.push(e);
    }
  }
  return out;
}

/**
 * Plain JSON-safe deep clone of a Board. `applyOps` mutates the board it is
 * handed, so pure transitions (replay steps, fixture store snapshots) clone
 * before mutating rather than aliasing previous models.
 */
export function cloneBoard(board: Board): Board {
  return {
    title: board.title,
    chapter: board.chapter,
    chapters: board.chapters.map(c => ({
      title: c.title,
      nodes: c.nodes.map(n => ({ ...n })),
      edges: c.edges.map(e => ({ ...e })),
      boundaries: c.boundaries.map(b => ({ ...b, members: b.members ? [...b.members] : undefined })),
      flow: c.flow.map(s => ({ ...s, lights: s.lights ? [...s.lights] : undefined })),
      callouts: c.callouts.map(o => ({ ...o })),
      transcript: c.transcript.map(t => ({ ...t })),
      groups: { ...c.groups },
      active: c.active,
      placed: Object.fromEntries(Object.entries(c.placed).map(([k, v]) => [k, { ...v }])),
      settled: c.settled,
    })),
    nodes: board.nodes.map(n => ({ ...n })),
    edges: board.edges.map(e => ({ ...e })),
    boundaries: board.boundaries.map(b => ({ ...b, members: b.members ? [...b.members] : undefined })),
    flow: board.flow.map(s => ({ ...s, lights: s.lights ? [...s.lights] : undefined })),
    callouts: board.callouts.map(o => ({ ...o })),
    transcript: board.transcript.map(t => ({ ...t })),
    groups: { ...board.groups },
    active: board.active,
    placed: Object.fromEntries(Object.entries(board.placed).map(([k, v]) => [k, { ...v }])),
    log: board.log.map(e => (e.op === 'amend'
      ? { ...e, ops: Array.isArray(e.ops) ? [...e.ops] : e.ops }
      : { ...e })),
    rev: board.rev,
    settled: board.settled,
  };
}
