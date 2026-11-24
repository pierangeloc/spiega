/* The live surface becomes a finished chapter at a break. Its already-drawn
   keys have to move with it, or returning to that chapter redraws the whole
   explanation and the next live surface inherits the old one's ink. */
export class InkMemory {
  private readonly surfaces = new Map<string, Set<string>>();
  private chapters: number | null = null;

  update(chapters: number): void {
    const before = this.chapters;
    this.chapters = chapters;
    if (before === null || before === chapters) return;
    if (chapters > before) {
      const live = this.surfaces.get('chapter-live');
      if (live) this.surfaces.set(`chapter-${chapters - 1}`, live);
      this.surfaces.delete('chapter-live');
    } else {
      this.surfaces.clear();
    }
  }

  surface(key: string): Set<string> {
    let ink = this.surfaces.get(key);
    if (!ink) { ink = new Set(); this.surfaces.set(key, ink); }
    return ink;
  }
}
