import { rateLabel } from '../../../../src/board/tape.js';
import type { Model } from '../app/model.js';
import type { Msg } from '../app/msg.js';

export function Transport({ model, dispatch }: {
  readonly model: Model,
  readonly dispatch: (msg: Msg) => unknown,
}) {
  const { narratorAvailable, tape, tapeIndex, tapePlaying, rate, voice, voices } = model.playback;
  if (!narratorAvailable) return <span title="speech synthesis is unavailable in this browser">no voice</span>;
  return <>
    <div className="transport" id="transport" role="group" aria-label="narration">
      <button className="btn icon" id="tprev" title="previous line (↑)" aria-label="previous line" disabled={!tape.length || tapeIndex <= 0} onClick={() => dispatch({ type: 'narratePrev' })}>
        <svg viewBox="0 0 12 12" aria-hidden="true"><rect x="1" y="1.5" width="2" height="9"/><path d="M11 1.5v9L4.5 6z"/></svg>
      </button>
      <button className={`btn icon${tapePlaying ? ' on' : ''}`} id="narrate" title="read the script aloud — space plays and pauses" aria-label={tapePlaying ? 'pause' : 'play'} disabled={!tape.length} onClick={() => dispatch({ type: 'narrateToggle' })}>
        <svg viewBox="0 0 12 12" aria-hidden="true">{tapePlaying ? <><rect x="2" y="1" width="3" height="10"/><rect x="7" y="1" width="3" height="10"/></> : <path d="M2.5 1v10L11 6z"/>}</svg>
      </button>
      <button className="btn icon" id="tnext" title="next line (↓)" aria-label="next line" disabled={!tape.length || tapeIndex >= tape.length - 1} onClick={() => dispatch({ type: 'narrateNext' })}>
        <svg viewBox="0 0 12 12" aria-hidden="true"><rect x="9" y="1.5" width="2" height="9"/><path d="M1 1.5v9L7.5 6z"/></svg>
      </button>
      <span className="pos" id="tpos" title="where the tape is up to">{tape.length ? `${tapeIndex < 0 ? '–' : tapeIndex + 1}/${tape.length}` : ''}</span>
      <button className="btn rate" id="rate" title="speed — each change restarts the sentence being read" onClick={() => dispatch({ type: 'cycleRate' })}>{rateLabel(rate)}</button>
    </div>
    {voices.length ? <select className="btn pick" id="voicepick" title="which voice reads it — choosing one speaks a sample" value={voice ?? voices[0].name} onChange={event => dispatch({ type: 'setVoice', name: event.target.value })}>
      {voices.map(v => <option key={v.name} value={v.name}>{v.name}{v.local ? '' : ' · online'}</option>)}
    </select> : null}
  </>;
}
