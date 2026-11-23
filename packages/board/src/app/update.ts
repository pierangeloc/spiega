/* ============================================================
   The pure state transition function: `(Model, Msg) => [Model, Cmd[]]`.

   No DOM, no React, no `speechSynthesis`, no timers, no `fetch`. All domain
   reasoning is delegated to the existing pure modules (`state`, `camera`,
   `map`, `script`, `tape`), and every side effect leaves as a `Cmd`.
   ============================================================ */

import { applyOps, emptyBoard } from '../../../../src/board/state.js';
import { frame, litKeys, unionBox, type View } from '../../../../src/board/camera.js';
import { clickNode, clickStep } from '../../../../src/board/script.js';
import { locate, nextRate, worthAnOutline } from '../../../../src/board/tape.js';
import type { Cmd } from './cmd.js';
import {
  chapterFromHash,
  clampRate,
  cloneBoard,
  computeTape,
  currentSurface,
  FLOW_TICK_MS,
  MAX_ZOOM,
  MIN_ZOOM,
  narratorDrives,
  replayEntries,
  visibleArea,
  type ChapterRef,
  type Model,
} from './model.js';
import type { Msg } from './msg.js';

export type UpdateResult = readonly [Model, readonly Cmd[]];

const noCmds = (model: Model): UpdateResult => [model, []];

function addChanged(list: readonly ChapterRef[], ref: ChapterRef): readonly ChapterRef[] {
  return list.includes(ref) ? list : [...list, ref];
}

function removeChanged(list: readonly ChapterRef[], ref: ChapterRef): readonly ChapterRef[] {
  return list.includes(ref) ? list.filter(x => x !== ref) : list;
}

/**
 * Compute the fit-to-stage view, matching board.html's `fit()`.
 * Returns `null` when the stage is too small to fit sensibly (e.g. mid-resize).
 */
function computeFitView(model: Model): View | null {
  const W = Math.max(1, model.camera.canvas.w);
  const H = Math.max(1, model.camera.canvas.h);
  const hasFlow = (currentSurface(model)?.flow.length ?? 0) > 0;
  const aw = model.camera.stage.w - 32;
  const ah = model.camera.stage.h - (hasFlow ? 86 : 32);
  if (aw < 40 || ah < 40) return null;
  const k = Math.max(0.05, Math.min(1.25, aw / W, ah / H));
  return {
    k,
    x: (model.camera.stage.w - W * k) / 2,
    y: Math.max(12, (ah - H * k) / 2),
  };
}

function withFit(model: Model, smooth: boolean): Model {
  const nextView = computeFitView(model);
  if (!nextView) {
    return {
      ...model,
      camera: { ...model.camera, userMoved: false, smooth },
    };
  }
  return {
    ...model,
    camera: { ...model.camera, view: nextView, userMoved: false, smooth },
  };
}

/**
 * Bring the active step's lit boxes into view when `following` is enabled,
 * using `camera.frame`. Returns the model unchanged if the whole board or the
 * subject is already comfortably visible.
 */
function withFrameStep(model: Model): Model {
  if (!model.camera.following || model.replay.active || model.mapOpen) return model;
  const surface = currentSurface(model);
  if (!surface || surface.active == null) return model;
  const step = surface.flow[surface.active];
  if (!step) return model;
  const nextView = frame({
    subject: unionBox(model.camera.boxes, litKeys(step)),
    canvas: {
      w: Math.max(1, model.camera.canvas.w),
      h: Math.max(1, model.camera.canvas.h),
    },
    view: model.camera.view,
    visible: visibleArea(model),
    offset: model.camera.offset,
  });
  if (!nextView) return model;
  return {
    ...model,
    camera: {
      ...model.camera,
      view: nextView,
      userMoved: true,
      smooth: true,
    },
  };
}

/** Refresh `playback.tape` from the current model, preserving position where possible. */
function withLoadedTape(model: Model): UpdateResult {
  const prev = model.playback.tape;
  const next = computeTape(model);
  const tapeEnded = next.length > prev.length ? false : model.playback.tapeEnded;
  const tapeIndex = model.playback.tapeIndex >= next.length
    ? next.length - 1
    : model.playback.tapeIndex;
  let nextModel: Model = {
    ...model,
    playback: {
      ...model.playback,
      tape: next,
      tapeIndex,
      tapeEnded,
    },
  };
  const cmds: Cmd[] = [];
  if (narratorDrives(nextModel) && nextModel.playback.flowPlaying) {
    nextModel = {
      ...nextModel,
      playback: { ...nextModel.playback, flowPlaying: false },
    };
    cmds.push({ type: 'stopFlowTimer' });
  }
  return [nextModel, cmds];
}

function stopPlaybackCmds(model: Model): { model: Model, cmds: Cmd[] } {
  const cmds: Cmd[] = [];
  let playback = model.playback;
  if (playback.tapePlaying || playback.tapeIndex >= 0 || playback.tapeEnded) {
    playback = { ...playback, tapePlaying: false, tapeIndex: -1, tapeEnded: false };
    cmds.push({ type: 'narratorStop' });
  }
  if (playback.flowPlaying) {
    playback = { ...playback, flowPlaying: false };
    cmds.push({ type: 'stopFlowTimer' });
  }
  return { model: { ...model, playback }, cmds };
}

function focusStep(model: Model, step: number | null): UpdateResult {
  if (model.replay.active || !model.board) return noCmds(model);
  if (model.viewing === null) {
    if (model.exported) {
      const nextBoard = { ...model.board, active: step };
      const updated = withFrameStep({ ...model, board: nextBoard });
      return noCmds(updated);
    }
    return [model, [{ type: 'postOps', ops: [{ op: 'focus', step }] }]];
  }
  const updated = withFrameStep({ ...model, chapterStep: step });
  return noCmds(updated);
}

function selectChapter(model: Model, rawChapter: ChapterRef, keepTape = false): UpdateResult {
  if (model.replay.active) return noCmds(model);
  const chapter: ChapterRef = rawChapter != null && model.board?.chapters[rawChapter]
    ? rawChapter
    : null;
  const chapterStep = chapter == null
    ? null
    : (model.board?.chapters[chapter]?.active ?? null);

  let nextModel: Model = {
    ...model,
    viewing: chapter,
    chapterStep,
    mapOpen: false,
    changed: removeChanged(model.changed, chapter),
  };

  const cmds: Cmd[] = [];
  if (!keepTape) {
    const stopped = stopPlaybackCmds({
      ...nextModel,
      playback: { ...nextModel.playback, tapeWhole: false },
    });
    nextModel = stopped.model;
    cmds.push(...stopped.cmds);
  }

  nextModel = withFit(nextModel, true);
  const [withTape, tapeCmds] = withLoadedTape(nextModel);
  cmds.push(...tapeCmds);
  cmds.push({ type: 'setHash', hash: chapter == null ? '' : `#${chapter + 1}` });
  return [withTape, cmds];
}

function openMap(model: Model, keepTape = false): UpdateResult {
  if (model.replay.active) return noCmds(model);
  let nextModel: Model = { ...model, mapOpen: true };
  const cmds: Cmd[] = [];
  if (!keepTape) {
    const tapeWhole = worthAnOutline(model.board);
    const stopped = stopPlaybackCmds({
      ...nextModel,
      playback: { ...nextModel.playback, tapeWhole },
    });
    nextModel = stopped.model;
    cmds.push(...stopped.cmds);
  }
  const [withTape, tapeCmds] = withLoadedTape(nextModel);
  cmds.push(...tapeCmds);
  cmds.push({ type: 'setHash', hash: '#map' });
  return [withTape, cmds];
}

function applySectionStart(model: Model, index: number): UpdateResult {
  const section = model.playback.tape[index];
  if (!section) return noCmds(model);
  let nextModel: Model = {
    ...model,
    playback: { ...model.playback, tapeIndex: index },
  };
  const cmds: Cmd[] = [];
  if (section.kind === 'outline') {
    if (!nextModel.mapOpen) {
      const [m, c] = openMap(nextModel, true);
      nextModel = m;
      cmds.push(...c);
    }
  } else {
    const targetChapter = section.chapter ?? null;
    if (nextModel.mapOpen || targetChapter !== nextModel.viewing) {
      const [m, c] = selectChapter(nextModel, targetChapter, true);
      nextModel = m;
      cmds.push(...c);
    }
    if (section.step != null && currentSurface(nextModel)?.active !== section.step) {
      const [m, c] = focusStep(nextModel, section.step);
      nextModel = m;
      cmds.push(...c);
    }
  }
  return [nextModel, cmds];
}

function startNarrate(model: Model, from?: number): UpdateResult {
  if (model.replay.active) return noCmds(model);
  const { narratorAvailable, tape, tapeEnded, tapeIndex, rate, voice, flowPlaying } = model.playback;
  if (!narratorAvailable || !tape.length) return noCmds(model);
  const want = from ?? (tapeEnded || tapeIndex < 0 ? 0 : tapeIndex);
  const index = Math.max(0, Math.min(want, tape.length - 1));
  const cmds: Cmd[] = [];
  if (flowPlaying) cmds.push({ type: 'stopFlowTimer' });
  cmds.push({ type: 'narratorPlay', index, rate, voice });
  const nextModel: Model = {
    ...model,
    playback: {
      ...model.playback,
      tapePlaying: true,
      tapeIndex: index,
      tapeEnded: false,
      flowPlaying: false,
    },
  };
  return [nextModel, cmds];
}

function moveNarrate(model: Model, target: number): UpdateResult {
  if (model.replay.active) return noCmds(model);
  const { tape, tapePlaying } = model.playback;
  if (!tape.length) return noCmds(model);
  const k = Math.max(0, Math.min(target, tape.length - 1));
  if (tapePlaying) return startNarrate(model, k);
  const parked: Model = {
    ...model,
    playback: { ...model.playback, tapeIndex: k, tapeEnded: false },
  };
  return applySectionStart(parked, k);
}

function startReplay(model: Model): UpdateResult {
  const entries = replayEntries(model.board?.log ?? []);
  if (!entries.length) return noCmds(model);
  const stopped = stopPlaybackCmds({
    ...model,
    playback: { ...model.playback, tapeWhole: false },
  });
  const nextModel: Model = {
    ...stopped.model,
    viewing: null,
    chapterStep: null,
    mapOpen: false,
    changed: [],
    caption: null,
    camera: { ...stopped.model.camera, userMoved: false },
    replay: {
      active: true,
      board: emptyBoard(),
      chapterAt: null,
      entries,
      index: 0,
    },
  };
  return [nextModel, [...stopped.cmds, { type: 'scheduleReplayStep', delayMs: 400 }]];
}

function stopReplay(model: Model): UpdateResult {
  if (!model.replay.active) return noCmds(model);
  const base: Model = {
    ...model,
    caption: null,
    replay: {
      active: false,
      board: null,
      chapterAt: null,
      entries: [],
      index: 0,
    },
  };
  const fitted = withFit(base, true);
  const [withTape, tapeCmds] = withLoadedTape(fitted);
  return [withTape, [{ type: 'cancelReplay' }, ...tapeCmds]];
}

function stepReplay(model: Model): UpdateResult {
  if (!model.replay.active || !model.replay.board) return noCmds(model);
  const { entries, index } = model.replay;
  if (index >= entries.length) return stopReplay(model);

  const entry = entries[index];
  const nextBoard = cloneBoard(model.replay.board);
  applyOps(nextBoard, [entry]);

  let caption = model.caption;
  let chapterAt: number | null = null;
  let delayMs = 660;

  if (entry.op === 'say') {
    const text = typeof entry.text === 'string' ? entry.text : '';
    caption = { text, problem: false };
    delayMs = Math.min(4200, 850 + text.length * 26);
  } else if (entry.op === 'title') {
    delayMs = 200;
  } else if (entry.op === 'chapter') {
    caption = nextBoard.chapter ? { text: `**${nextBoard.chapter}**`, problem: false } : null;
    delayMs = nextBoard.chapter ? 1500 : 260;
  } else if (entry.op === 'amend') {
    const i = Number(entry.chapter) - 1;
    if (i >= 0 && i < nextBoard.chapters.length) {
      chapterAt = i;
      const name = nextBoard.chapters[i].title || 'the chapter before';
      caption = { text: `back to **${name}**`, problem: false };
      delayMs = 1200;
    }
  } else {
    caption = null;
  }

  const nextModel: Model = {
    ...model,
    caption,
    replay: {
      ...model.replay,
      board: nextBoard,
      chapterAt,
      index: index + 1,
    },
  };
  return [nextModel, [{ type: 'scheduleReplayStep', delayMs }]];
}

export function update(model: Model, msg: Msg): UpdateResult {
  switch (msg.type) {
    case 'stateReceived': {
      const first = model.board === null;
      const prevActive = model.board?.active ?? null;
      const nextBoard = msg.board;

      let changed = model.changed;
      for (const n of msg.amended ?? []) {
        const i: ChapterRef = n - 1 < nextBoard.chapters.length ? n - 1 : null;
        if (i !== model.viewing) changed = addChanged(changed, i);
      }
      if (model.viewing != null && !first) {
        changed = addChanged(changed, null);
      }

      const viewingValid = model.viewing == null || Boolean(nextBoard.chapters[model.viewing]);
      const viewing = viewingValid ? model.viewing : null;
      const chapterStep = viewingValid ? model.chapterStep : null;

      if (model.replay.active) {
        return noCmds({ ...model, board: nextBoard, changed, viewing, chapterStep });
      }

      let nextModel: Model = {
        ...model,
        board: nextBoard,
        viewing,
        chapterStep,
        changed,
        link: model.exported ? 'idle' : 'live',
      };

      // First-arrival landing: a chapter hash wins; otherwise a multi-chapter
      // board opens on the map so a reader sees the whole before diving in.
      if (first) {
        const hashChapter = chapterFromHash(nextBoard, msg.hash);
        if (hashChapter != null) {
          return selectChapter(nextModel, hashChapter);
        }
        if (msg.hash === '#map' || (!msg.hash && nextBoard.chapters.length >= 2)) {
          return openMap(nextModel);
        }
        nextModel = {
          ...nextModel,
          camera: { ...nextModel.camera, userMoved: false },
        };
      }

      if (!nextModel.camera.userMoved && !nextModel.mapOpen) {
        nextModel = withFit(nextModel, !first);
      }
      if (!nextModel.mapOpen && nextModel.viewing === null && nextBoard.active !== prevActive) {
        nextModel = withFrameStep(nextModel);
      }

      return withLoadedTape(nextModel);
    }

    case 'linkChanged':
      return noCmds({ ...model, link: msg.status });

    case 'savingChanged':
      return noCmds({ ...model, saving: msg.status });

    case 'focusStep':
      return focusStep(model, msg.step);

    case 'stepNext': {
      const surface = currentSurface(model);
      const len = surface?.flow.length ?? 0;
      if (!len || model.replay.active) return noCmds(model);
      const next = surface?.active == null ? 0 : Math.min(len - 1, surface.active + 1);
      return focusStep(model, next);
    }

    case 'stepPrev': {
      const surface = currentSurface(model);
      const len = surface?.flow.length ?? 0;
      if (!len || model.replay.active) return noCmds(model);
      const prev = Math.max(0, (surface?.active ?? 0) - 1);
      return focusStep(model, prev);
    }

    case 'clickLine': {
      if (model.replay.active) return noCmds(model);
      const at = locate([...model.playback.tape], model.viewing, msg.line);
      if (model.playback.narratorAvailable && model.playback.tapePlaying) {
        return at >= 0 ? startNarrate(model, at) : noCmds(model);
      }
      let nextModel = model;
      const cmds: Cmd[] = [];
      if (msg.step != null) {
        const want = clickStep(currentSurface(model) ?? undefined, msg.step);
        if (want !== undefined) {
          const [m, c] = focusStep(nextModel, want);
          nextModel = m;
          cmds.push(...c);
        }
      }
      if (nextModel.playback.narratorAvailable && at >= 0) {
        nextModel = {
          ...nextModel,
          playback: { ...nextModel.playback, tapeIndex: at, tapeEnded: false },
        };
        cmds.push({ type: 'narratorPark', index: at });
      }
      return [nextModel, cmds];
    }

    case 'clickNode': {
      if (model.replay.active) return noCmds(model);
      const surface = currentSurface(model);
      const want = clickNode(surface ?? undefined, msg.nodeId, surface?.active ?? null);
      if (want === undefined) return noCmds(model);
      return focusStep(model, want);
    }

    case 'selectChapter':
      return selectChapter(model, msg.chapter, msg.keepTape);

    case 'openMap':
      return openMap(model, msg.keepTape);

    case 'closeMap':
      return selectChapter(model, model.viewing);

    case 'hashChanged': {
      if (msg.hash === '#map') return openMap(model);
      return selectChapter(model, chapterFromHash(model.board, msg.hash));
    }

    case 'toggleFollow': {
      const following = !model.camera.following;
      let nextModel: Model = {
        ...model,
        camera: { ...model.camera, following },
      };
      if (following) nextModel = withFrameStep(nextModel);
      return [nextModel, [{ type: 'persistFollow', following }]];
    }

    case 'fit':
      return noCmds(withFit(model, msg.smooth ?? false));

    case 'pan':
      return noCmds({
        ...model,
        camera: {
          ...model.camera,
          userMoved: true,
          smooth: false,
          view: {
            ...model.camera.view,
            x: model.camera.view.x + msg.dx,
            y: model.camera.view.y + msg.dy,
          },
        },
      });

    case 'zoom': {
      const { view, stage } = model.camera;
      const cx = msg.origin?.x ?? stage.w / 2;
      const cy = msg.origin?.y ?? stage.h / 2;
      const k = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, view.k * msg.factor));
      const ratio = k / view.k;
      return noCmds({
        ...model,
        camera: {
          ...model.camera,
          userMoved: true,
          smooth: msg.smooth ?? false,
          view: {
            k,
            x: cx - (cx - view.x) * ratio,
            y: cy - (cy - view.y) * ratio,
          },
        },
      });
    }

    case 'stageResized': {
      const updated: Model = {
        ...model,
        camera: {
          ...model.camera,
          stage: msg.size,
          stepsBarHeight: msg.stepsBarHeight ?? model.camera.stepsBarHeight,
        },
      };
      return noCmds(!updated.camera.userMoved && !updated.replay.active ? withFit(updated, false) : updated);
    }

    case 'layoutMeasured': {
      const updated: Model = {
        ...model,
        camera: {
          ...model.camera,
          canvas: msg.canvas,
          boxes: msg.boxes,
          offset: msg.offset,
        },
      };
      return noCmds(!updated.camera.userMoved && !updated.replay.active ? withFit(updated, false) : updated);
    }

    case 'narrateToggle': {
      if (model.playback.tapePlaying) {
        return [
          { ...model, playback: { ...model.playback, tapePlaying: false } },
          [{ type: 'narratorPause' }],
        ];
      }
      return startNarrate(model);
    }

    case 'narratePlay':
      return startNarrate(model, msg.index);

    case 'narratePause': {
      if (!model.playback.tapePlaying) return noCmds(model);
      return [
        { ...model, playback: { ...model.playback, tapePlaying: false } },
        [{ type: 'narratorPause' }],
      ];
    }

    case 'narrateNext':
      return moveNarrate(model, model.playback.tapeIndex + 1);

    case 'narratePrev':
      return moveNarrate(model, model.playback.tapeIndex - 1);

    case 'narrateRestart':
      return moveNarrate(model, model.playback.tapeIndex < 0 ? 0 : model.playback.tapeIndex);

    case 'narrateSectionStarted':
      return applySectionStart(model, msg.index);

    case 'narrateSectionEnded': {
      if (msg.index < model.playback.tape.length - 1) return noCmds(model);
      const finished: Model = {
        ...model,
        playback: { ...model.playback, tapePlaying: false, tapeEnded: true },
      };
      if (model.playback.tape[0]?.kind === 'outline' && !model.mapOpen) {
        return openMap(finished, true);
      }
      return noCmds(finished);
    }

    case 'narrateStopped':
      return noCmds({
        ...model,
        playback: { ...model.playback, tapePlaying: false },
      });

    case 'cycleRate':
      return update(model, { type: 'setRate', rate: nextRate(model.playback.rate) });

    case 'setRate': {
      const rate = clampRate(msg.rate);
      return [
        { ...model, playback: { ...model.playback, rate } },
        [{ type: 'narratorSetRate', rate }],
      ];
    }

    case 'setVoice': {
      const nextModel: Model = {
        ...model,
        playback: { ...model.playback, voice: msg.name, tapePlaying: false },
      };
      return [
        nextModel,
        [
          { type: 'persistVoice', name: msg.name },
          { type: 'narratorSetVoice', name: msg.name },
          { type: 'narratorSample', name: msg.name, rate: model.playback.rate },
        ],
      ];
    }

    case 'voicesChanged':
      return noCmds({
        ...model,
        playback: {
          ...model.playback,
          voices: msg.voices,
          voice: msg.selected !== undefined ? msg.selected : model.playback.voice,
        },
      });

    case 'flowPlayToggle': {
      if (model.playback.flowPlaying) {
        return [
          { ...model, playback: { ...model.playback, flowPlaying: false } },
          [{ type: 'stopFlowTimer' }],
        ];
      }
      if (narratorDrives(model) || model.replay.active) return noCmds(model);
      const surface = currentSurface(model);
      const len = surface?.flow.length ?? 0;
      if (!len) return noCmds(model);
      const first = surface?.active == null || surface.active >= len - 1 ? 0 : surface.active + 1;
      const started: Model = {
        ...model,
        playback: { ...model.playback, flowPlaying: true },
      };
      const [focused, focusCmds] = focusStep(started, first);
      return [focused, [{ type: 'startFlowTimer', intervalMs: FLOW_TICK_MS }, ...focusCmds]];
    }

    case 'flowTick': {
      if (!model.playback.flowPlaying) return noCmds(model);
      const surface = currentSurface(model);
      const len = surface?.flow.length ?? 0;
      const next = (surface?.active ?? -1) + 1;
      if (next >= len) {
        return [
          { ...model, playback: { ...model.playback, flowPlaying: false } },
          [{ type: 'stopFlowTimer' }],
        ];
      }
      return focusStep(model, next);
    }

    case 'replayToggle':
      return model.replay.active ? stopReplay(model) : startReplay(model);

    case 'replayStart': {
      const base = model.replay.active ? stopReplay(model)[0] : model;
      return startReplay(base);
    }

    case 'replayStop':
      return stopReplay(model);

    case 'replayStep':
      return stepReplay(model);

    case 'keyDown': {
      const { key } = msg;
      if (model.playback.narratorAvailable) {
        if (key === ' ') return update(model, { type: 'narrateToggle' });
        if (key === 'ArrowDown') return update(model, { type: 'narrateNext' });
        if (key === 'ArrowUp') return update(model, { type: 'narratePrev' });
        if (key === 'r' && model.playback.tapePlaying) return update(model, { type: 'narrateRestart' });
        if (key === '[') return update(model, { type: 'setRate', rate: model.playback.rate - 0.1 });
        if (key === ']') return update(model, { type: 'setRate', rate: model.playback.rate + 0.1 });
      }
      if (key === '+' || key === '=') return update(model, { type: 'zoom', factor: 1.25, smooth: true });
      if (key === '-' || key === '_') return update(model, { type: 'zoom', factor: 1 / 1.25, smooth: true });
      if (key === '0' || key === 'f') return update(model, { type: 'fit', smooth: true });
      if (key === 'ArrowRight') return update(model, { type: 'stepNext' });
      if (key === 'ArrowLeft') return update(model, { type: 'stepPrev' });
      if (key === 'r') return update(model, { type: 'replayToggle' });
      if (key === 'm') {
        if (model.mapOpen) return update(model, { type: 'closeMap' });
        if (model.board?.chapters.length) return update(model, { type: 'openMap' });
        return noCmds(model);
      }
      if (key === 'Escape') {
        if (model.exportMenuOpen) return noCmds({ ...model, exportMenuOpen: false });
        if (model.replay.active) return stopReplay(model);
        if (model.mapOpen) return update(model, { type: 'closeMap' });
        return focusStep(model, null);
      }
      return noCmds(model);
    }

    case 'toggleRail': {
      const toggled: Model = { ...model, railOpen: !model.railOpen };
      return noCmds(!toggled.camera.userMoved ? withFit(toggled, true) : toggled);
    }

    case 'toggleExportMenu':
      return noCmds({ ...model, exportMenuOpen: !model.exportMenuOpen });

    case 'closeExportMenu':
      return model.exportMenuOpen ? noCmds({ ...model, exportMenuOpen: false }) : noCmds(model);

    case 'requestExport': {
      if (model.exported || !model.board) return noCmds({ ...model, exportMenuOpen: false });
      const chapter = model.viewing == null ? model.board.chapters.length : model.viewing;
      const viewing: 'map' | 'live' | number = model.mapOpen
        ? 'map'
        : model.viewing == null ? 'live' : model.viewing;
      const step = currentSurface(model)?.active ?? null;
      return [
        { ...model, exportMenuOpen: false },
        [{ type: 'exportBoard', scope: msg.scope, chapter, viewing, step }],
      ];
    }

    case 'setCaption':
      return noCmds({ ...model, caption: msg.caption });

    default: {
      const exhaustive: never = msg;
      return noCmds(exhaustive);
    }
  }
}
