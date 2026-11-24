/* The command boundary around the player. The host supplies the player and the
   current model; update remains the only place that decides what to request. */
import type { Section } from '../../../../src/board/tape.js';
import type { Cmd } from './cmd.js';
import type { Model } from './model.js';
import type { Msg } from './msg.js';

export type NarrationSection = Section & {
  onStart(): void,
  onDone(): void,
  onWord(offset: number): void,
};

export type NarrationPlayer = {
  load(sections: NarrationSection[]): void,
  play(index: number): void,
  pause(): void,
  rewind(): void,
  park(index: number): void,
  setRate(rate: number): void,
  setVoice(name: string): unknown,
  sample(): void,
};

export function narrationRunner(player: NarrationPlayer, snapshot: () => Model) {
  let generation = 0;
  return (cmd: Cmd, dispatch: (msg: Msg) => readonly Cmd[]): void => {
    const load = (): void => {
      const current = ++generation;
      player.load(snapshot().playback.tape.map((section, index) => ({
        ...section,
        onStart: () => { if (current === generation) dispatch({ type: 'narrateSectionStarted', index }); },
        onDone: () => { if (current === generation) dispatch({ type: 'narrateSectionEnded', index }); },
        onWord: (offset) => { if (current === generation) dispatch({ type: 'narrateWord', index, offset }); },
      })));
    };
    switch (cmd.type) {
      case 'narratorPlay':
        load();
        player.play(cmd.index);
        break;
      case 'narratorPause': generation++; player.pause(); break;
      case 'narratorStop': generation++; player.rewind(); break;
      case 'narratorPark': load(); player.park(cmd.index); break;
      case 'narratorSetRate': player.setRate(cmd.rate); break;
      case 'narratorSetVoice': player.setVoice(cmd.name); break;
      case 'narratorSample': generation++; player.sample(); break;
    }
  };
}
