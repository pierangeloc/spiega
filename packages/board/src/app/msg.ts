/* ============================================================
   Everything that can happen to the board page, as a tagged union.

   Every user gesture (click, key press, pan, zoom), every transport event
   (a board revision arriving, connection state, saving status), and every
   playback/replay callback arrives as a `Msg` and goes through `update`.
   ============================================================ */

import type { Board, Fresh } from '../../../../src/board/state.js';
import type { Box, Point, Size } from '../../../../src/board/camera.js';
import type {
  Caption,
  ChapterRef,
  LinkStatus,
  SavingStatus,
  VoiceInfo,
} from './model.js';

export type Msg =
  // Transport & server state
  | {
      readonly type: 'stateReceived',
      readonly board: Board,
      readonly fresh?: Fresh,
      readonly amended?: readonly number[],
      readonly full?: boolean,
      readonly hash?: string,
    }
  | { readonly type: 'linkChanged', readonly status: LinkStatus }
  | { readonly type: 'savingChanged', readonly status: SavingStatus }

  // Stepping & clicks
  | { readonly type: 'focusStep', readonly step: number | null }
  | { readonly type: 'stepNext' }
  | { readonly type: 'stepPrev' }
  | { readonly type: 'clickLine', readonly line: number, readonly step: number | null }
  | { readonly type: 'clickNode', readonly nodeId: string }

  // Chapters & map
  | { readonly type: 'selectChapter', readonly chapter: ChapterRef, readonly keepTape?: boolean }
  | { readonly type: 'openMap', readonly keepTape?: boolean }
  | { readonly type: 'closeMap' }
  | { readonly type: 'hashChanged', readonly hash: string }

  // Camera & viewport
  | { readonly type: 'toggleFollow' }
  | { readonly type: 'fit', readonly smooth?: boolean }
  | { readonly type: 'pan', readonly dx: number, readonly dy: number }
  | { readonly type: 'zoom', readonly factor: number, readonly origin?: Point, readonly smooth?: boolean }
  | { readonly type: 'stageResized', readonly size: Size, readonly stepsBarHeight?: number }
  | {
      readonly type: 'layoutMeasured',
      readonly canvas: Size,
      readonly boxes: Readonly<Record<string, Box>>,
      readonly offset: Point,
    }

  // Narrator tape & silent flow playback
  | { readonly type: 'narrateToggle' }
  | { readonly type: 'narratePlay', readonly index?: number }
  | { readonly type: 'narratePause' }
  | { readonly type: 'narrateNext' }
  | { readonly type: 'narratePrev' }
  | { readonly type: 'narrateRestart' }
  | { readonly type: 'narrateSectionStarted', readonly index: number }
  | { readonly type: 'narrateSectionEnded', readonly index: number }
  | { readonly type: 'narrateStopped' }
  | { readonly type: 'cycleRate' }
  | { readonly type: 'setRate', readonly rate: number }
  | { readonly type: 'setVoice', readonly name: string }
  | { readonly type: 'voicesChanged', readonly voices: readonly VoiceInfo[], readonly selected?: string | null }
  | { readonly type: 'flowPlayToggle' }
  | { readonly type: 'flowTick' }

  // Session replay
  | { readonly type: 'replayToggle' }
  | { readonly type: 'replayStart' }
  | { readonly type: 'replayStop' }
  | { readonly type: 'replayStep' }

  // Keyboard & chrome
  | { readonly type: 'keyDown', readonly key: string }
  | { readonly type: 'toggleRail' }
  | { readonly type: 'toggleExportMenu' }
  | { readonly type: 'closeExportMenu' }
  | { readonly type: 'requestExport', readonly scope: 'all' | 'chapter' }
  | { readonly type: 'setCaption', readonly caption: Caption | null };
