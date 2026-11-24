import { Fragment } from 'react';

/* Offsets count the plain spoken text, not its markdown delimiters. */
export function spokenWords(text: string, offset: number) {
  let position = 0;
  const words = (part: string) => part.split(/(\s+)/).filter(Boolean).map((word, i) => {
    const start = position;
    position += word.length;
    return /^\s+$/.test(word) ? word : <span key={i} className={`w${start <= offset && offset < position ? ' lit' : ''}`}>{word}</span>;
  });
  return text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g).filter(Boolean).map((part, i) => {
    if (part.startsWith('`') && part.endsWith('`')) return <code key={i}>{words(part.slice(1, -1))}</code>;
    if (part.startsWith('**') && part.endsWith('**')) return <b key={i}>{words(part.slice(2, -2))}</b>;
    return <Fragment key={i}>{words(part)}</Fragment>;
  });
}
