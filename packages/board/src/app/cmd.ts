/* ============================================================
   Commands returned by `update(model, msg)`.

   `update` never performs I/O, never touches `localStorage`, never calls
   `speechSynthesis`, and never schedules timers. Instead it returns a list of
   commands describing what the host (browser runtime or fixture store) should
   run.
   ============================================================ */

import type { Op } from '../../../../src/board/state.js';
import type { SettleGated } from './msg.js';

export type Cmd =
  | { readonly type: 'postOps', readonly ops: readonly Op[] }
  | { readonly type: 'settleBoard', readonly then: SettleGated }
  | { readonly type: 'setHash', readonly hash: string }
  | { readonly type: 'persistFollow', readonly following: boolean }
  | { readonly type: 'persistVoice', readonly name: string }
  | {
      readonly type: 'narratorPlay',
      readonly index: number,
      readonly rate: number,
      readonly voice: string | null,
    }
  | { readonly type: 'narratorPause' }
  | { readonly type: 'narratorStop' }
  | { readonly type: 'narratorPark', readonly index: number }
  | { readonly type: 'narratorSetRate', readonly rate: number }
  | { readonly type: 'narratorSetVoice', readonly name: string }
  | { readonly type: 'narratorSample', readonly name: string, readonly rate: number }
  | { readonly type: 'startFlowTimer', readonly intervalMs: number }
  | { readonly type: 'stopFlowTimer' }
  | { readonly type: 'scheduleReplayStep', readonly delayMs: number }
  | { readonly type: 'cancelReplay' }
  | {
      readonly type: 'exportBoard',
      readonly scope: 'all' | 'chapter',
      readonly chapter: number,
      readonly viewing: 'map' | 'live' | number,
      readonly step: number | null,
    };
