// Lap timing with ordered checkpoints, cut / wrong-way detection and split times.
// ---------------------------------------------------------------------------------
// Lap timing with checkpoints
// ---------------------------------------------------------------------------------
export class LapTimer {
  constructor(track) {
    this.track = track;
    this.n = track.checkpoints.length;
    this.reset();
  }
  reset() {
    this.lapStart = null;
    this.lap = 0;
    this.nextCp = 1;
    this.valid = false;
    this.prevRel = null;
    this.hint = -1;
    this.last = null;
    this.sessionBest = null;
    this.splits = [];
    this.lastSplitDelta = null;
    this.invalidReason = '';
  }
  rel(s) {
    const L = this.track.length;
    let r = (s - this.track.finishS) % L;
    if (r < 0) r += L;
    return r;
  }
  /** Returns an array of events: {type:'lapStart'|'lap'|'cp'|'invalid', ...} */
  update(x, z, now, bestSplits) {
    const tr = this.track;
    const pr = tr.project(x, z, this.hint);
    this.hint = pr.index;
    const L = tr.length;
    const rel = this.rel(pr.s);
    const ev = [];
    const w = tr.interp(tr.W, pr.s);
    if (pr.dist > w + 22 && this.valid) {
      this.valid = false;
      this.invalidReason = 'Off track';
      ev.push({ type: 'invalid', reason: 'Off track — lap invalid' });
    }
    if (this.prevRel != null) {
      const d = rel - this.prevRel;
      if (d < -L / 2) {
        // crossed the finish line forwards
        if (this.lapStart != null && this.valid && this.nextCp >= this.n) {
          const time = now - this.lapStart;
          this.last = time;
          if (this.sessionBest == null || time < this.sessionBest) this.sessionBest = time;
          ev.push({ type: 'lap', time, splits: this.splits.slice() });
        }
        this.lapStart = now;
        this.lap++;
        this.nextCp = 1;
        this.valid = true;
        this.invalidReason = '';
        this.splits = [];
        this.lastSplitDelta = null;
        ev.push({ type: 'lapStart', lap: this.lap });
      } else if (d > L / 2) {
        if (this.valid) ev.push({ type: 'invalid', reason: 'Wrong way — lap invalid' });
        this.valid = false;
        this.invalidReason = 'Wrong way';
      } else if (this.lapStart != null && d > 0) {
        for (let k = 1; k < this.n; k++) {
          const cr = (k * L) / this.n;
          if (this.prevRel < cr && rel >= cr) {
            if (k === this.nextCp) {
              this.nextCp++;
              const split = now - this.lapStart;
              this.splits.push(split);
              const bs = bestSplits && bestSplits[k - 1];
              this.lastSplitDelta = bs != null ? split - bs : null;
              ev.push({ type: 'cp', k, split, delta: this.lastSplitDelta });
            } else if (k > this.nextCp && this.valid) {
              this.valid = false;
              this.invalidReason = 'Missed checkpoint';
              ev.push({ type: 'invalid', reason: 'Missed a checkpoint — lap invalid' });
            }
          }
        }
      }
    }
    this.prevRel = rel;
    return ev;
  }
  current(now) {
    return this.lapStart == null ? null : now - this.lapStart;
  }
  nextCheckpoint() {
    if (this.lapStart == null) return this.track.checkpoints[0];
    return this.track.checkpoints[this.nextCp % this.n];
  }
}

