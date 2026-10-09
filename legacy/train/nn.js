// Tiny feedforward neural network — no dependencies.
// Works in both Node.js (require) and browser (script tag).
// Architecture: arbitrary layer sizes, ReLU on hidden layers, linear output.
// Weights stored as flat arrays, row-major: w[outRow * inDim + inCol].

class TinyNN {
  // sizes: e.g. [32, 32, 5] = input→hidden→output
  constructor(sizes) {
    this.sizes  = sizes;
    this.layers = [];
    for (let l = 0; l < sizes.length - 1; l++) {
      const inD = sizes[l], outD = sizes[l + 1];
      const scale = Math.sqrt(2 / inD); // He initialisation
      this.layers.push({
        w:   Array.from({ length: outD * inD }, () => (Math.random() * 2 - 1) * scale),
        b:   new Array(outD).fill(0),
        inD, outD,
      });
    }
    this._acts = []; // cached activations (for backprop)
    this._pres = []; // cached pre-activations
  }

  // ── Forward pass ────────────────────────────────────────────────────────────
  // Returns the output array (Q-values or logits).
  forward(x) {
    this._acts = [x.slice()];
    this._pres = [];
    let cur = x.slice();
    for (let l = 0; l < this.layers.length; l++) {
      const { w, b, inD, outD } = this.layers[l];
      const pre = new Array(outD);
      for (let o = 0; o < outD; o++) {
        let s = b[o];
        for (let i = 0; i < inD; i++) s += w[o * inD + i] * cur[i];
        pre[o] = s;
      }
      this._pres.push(pre);
      // ReLU on hidden layers; linear on the final layer
      cur = (l < this.layers.length - 1) ? pre.map(v => Math.max(0, v)) : pre.slice();
      this._acts.push(cur);
    }
    return cur;
  }

  // ── Single-sample SGD update (DQN Bellman target) ───────────────────────────
  // Updates only the Q-value for `action` toward `targetQ`.
  // Call forward(state) before calling this.
  update(action, targetQ, lr = 0.001) {
    const q = this._acts[this._acts.length - 1];

    // Gradient of MSE loss w.r.t. output: non-zero only for the taken action
    let dX = new Array(q.length).fill(0);
    dX[action] = 2 * (q[action] - targetQ);

    // Backpropagate through layers (reverse order)
    for (let l = this.layers.length - 1; l >= 0; l--) {
      const { w, b, inD, outD } = this.layers[l];
      const pre     = this._pres[l];
      const prevAct = this._acts[l];

      // Apply ReLU derivative for hidden layers (last layer is linear)
      if (l < this.layers.length - 1) {
        dX = dX.map((d, i) => (pre[i] > 0 ? d : 0));
      }

      // Gradient w.r.t. previous activation (needed before weight update)
      const dPrev = new Array(inD).fill(0);
      for (let o = 0; o < outD; o++) {
        for (let i = 0; i < inD; i++) dPrev[i] += dX[o] * w[o * inD + i];
      }

      // Update weights and biases
      for (let o = 0; o < outD; o++) {
        b[o] -= lr * dX[o];
        for (let i = 0; i < inD; i++) w[o * inD + i] -= lr * dX[o] * prevAct[i];
      }

      dX = dPrev;
    }
  }

  // ── Supervised learning update ──────────────────────────────────────────────
  // Updates ALL outputs toward `targets` using MSE loss.
  // Call forward(state) before calling this.
  supervisedUpdate(targets, lr = 0.001) {
    const out = this._acts[this._acts.length - 1];
    let dX = out.map((o, i) => 2 * (o - (targets[i] ?? 0)));

    for (let l = this.layers.length - 1; l >= 0; l--) {
      const { w, b, inD, outD } = this.layers[l];
      const pre     = this._pres[l];
      const prevAct = this._acts[l];

      if (l < this.layers.length - 1) dX = dX.map((d, i) => pre[i] > 0 ? d : 0);

      const dPrev = new Array(inD).fill(0);
      for (let o = 0; o < outD; o++)
        for (let i = 0; i < inD; i++) dPrev[i] += dX[o] * w[o * inD + i];

      for (let o = 0; o < outD; o++) {
        b[o] -= lr * dX[o];
        for (let i = 0; i < inD; i++) w[o * inD + i] -= lr * dX[o] * prevAct[i];
      }
      dX = dPrev;
    }
  }

  // ── Target network support ──────────────────────────────────────────────────
  clone() {
    return TinyNN.load(this.serialize());
  }

  // ── Serialization ───────────────────────────────────────────────────────────
  serialize() {
    return this.layers.map(l => ({ w: l.w.slice(), b: l.b.slice(), inD: l.inD, outD: l.outD }));
  }

  static load(data) {
    const sizes = [data[0].inD, ...data.map(l => l.outD)];
    const nn    = new TinyNN(sizes);
    nn.layers   = data.map(l => ({
      w: l.w.slice(), b: l.b.slice(), inD: l.inD, outD: l.outD,
    }));
    return nn;
  }
}

if (typeof module !== 'undefined') module.exports = { TinyNN };
