#!/usr/bin/env python3
"""
Train a small MLP on the Monte Carlo combat dataset.

Architecture: 42 → 128 → 64 → 12  (ReLU hidden, Tanh output)
Loss: masked MSE on win_rates (soft labels, unavailable actions ignored)
Output: ml/model_weights.json  (vanilla-JS-compatible format)

Actions (12): atk_F, atk_D, atk_M, atk_C, bail, heal, smoke, pot,
              pot_A, pot_V, blood, priest_pot
Features (42): player/mob stats + HP + status + mob next attack + tier +
               consumable inventory (heal count, smoke, F/D/M/C pots,
               A pot, V pot, blood drop, priest blessing)

Usage:
    python3 ml/train.py [--data ml/training_data.jsonl] [--epochs 100]
"""

import json, argparse, time
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn
from torch.utils.data import Dataset, DataLoader, random_split

# ── Action index mapping (fixed, must match combat_nn.js) ────────────────────
ACTION_NAMES = [
    'atk_F', 'atk_D', 'atk_M', 'atk_C', 'bail',
    'heal', 'smoke', 'pot', 'pot_A', 'pot_V', 'blood', 'priest_pot',
]
ACTION_IDX   = {a: i for i, a in enumerate(ACTION_NAMES)}
N_ACTIONS    = len(ACTION_NAMES)
N_FEATURES   = 42

# ── Dataset ───────────────────────────────────────────────────────────────────

class CombatDataset(Dataset):
    def __init__(self, path):
        features, targets, masks = [], [], []
        with open(path) as f:
            for line in f:
                rec = json.loads(line)
                feat = rec['features']
                wr   = rec['win_rates']

                target = [0.0] * N_ACTIONS
                mask   = [0.0] * N_ACTIONS
                for action, rate in wr.items():
                    if action in ACTION_IDX:
                        i         = ACTION_IDX[action]
                        target[i] = rate
                        mask[i]   = 1.0

                # Normalize targets per sample: subtract mean of available actions.
                # Forces model to learn "is this action better than average for this
                # specific state?" rather than the marginal average per action type.
                avail_rates = [target[i] for i in range(N_ACTIONS) if mask[i] == 1.0]
                mean_rate   = sum(avail_rates) / len(avail_rates) if avail_rates else 0.0
                for i in range(N_ACTIONS):
                    if mask[i] == 1.0:
                        target[i] -= mean_rate   # centred around 0; range ~[-1, 1]

                features.append(feat)
                targets.append(target)
                masks.append(mask)

        self.X    = torch.tensor(features, dtype=torch.float32)
        self.Y    = torch.tensor(targets,  dtype=torch.float32)
        self.mask = torch.tensor(masks,    dtype=torch.float32)

    def __len__(self):  return len(self.X)
    def __getitem__(self, i): return self.X[i], self.Y[i], self.mask[i]

# ── Model ─────────────────────────────────────────────────────────────────────

class CombatNet(nn.Module):
    def __init__(self):
        super().__init__()
        self.net = nn.Sequential(
            nn.Linear(N_FEATURES, 128), nn.ReLU(),
            nn.Linear(128, 64),         nn.ReLU(),
            nn.Linear(64,  N_ACTIONS),  nn.Tanh(),   # 42→128→64→12
        )

    def forward(self, x):
        return self.net(x)

# ── Masked MSE loss ───────────────────────────────────────────────────────────

def masked_mse(pred, target, mask):
    err  = (pred - target) ** 2
    err  = err * mask                          # zero out unavailable actions
    denom = mask.sum().clamp(min=1)
    return err.sum() / denom

# ── Training ──────────────────────────────────────────────────────────────────

def train(data_path, epochs, batch_size, lr, val_frac, device):
    print(f"Loading dataset: {data_path}")
    ds = CombatDataset(data_path)
    print(f"  {len(ds)} records, {N_FEATURES} features, {N_ACTIONS} actions")

    n_val   = int(len(ds) * val_frac)
    n_train = len(ds) - n_val
    train_ds, val_ds = random_split(ds, [n_train, n_val],
                                    generator=torch.Generator().manual_seed(42))

    train_dl = DataLoader(train_ds, batch_size=batch_size, shuffle=True)
    val_dl   = DataLoader(val_ds,   batch_size=batch_size)

    model = CombatNet().to(device)
    opt   = torch.optim.Adam(model.parameters(), lr=lr)
    sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, T_max=epochs)

    print(f"\nTraining on {device}  ({n_train} train / {n_val} val)\n")
    best_val, best_state = float('inf'), None
    t0 = time.time()

    for epoch in range(1, epochs + 1):
        # Train
        model.train()
        train_loss = 0.0
        for X, Y, M in train_dl:
            X, Y, M = X.to(device), Y.to(device), M.to(device)
            opt.zero_grad()
            loss = masked_mse(model(X), Y, M)
            loss.backward()
            opt.step()
            train_loss += loss.item() * len(X)
        train_loss /= n_train

        # Validate
        model.eval()
        val_loss = 0.0
        correct  = 0
        with torch.no_grad():
            for X, Y, M in val_dl:
                X, Y, M = X.to(device), Y.to(device), M.to(device)
                pred = model(X)
                val_loss += masked_mse(pred, Y, M).item() * len(X)

                # Accuracy: does argmax(pred, masked) match argmax(target, masked)?
                pred_masked = pred.clone()
                pred_masked[M == 0] = -1
                tgt_masked  = Y.clone()
                tgt_masked[M == 0]  = -1
                correct += (pred_masked.argmax(1) == tgt_masked.argmax(1)).sum().item()

        val_loss /= n_val
        acc = correct / n_val * 100

        sched.step()

        if val_loss < best_val:
            best_val   = val_loss
            best_state = {k: v.cpu().clone() for k, v in model.state_dict().items()}

        if epoch % 10 == 0 or epoch == 1:
            elapsed = time.time() - t0
            print(f"  Epoch {epoch:3d}/{epochs}  "
                  f"train={train_loss:.5f}  val={val_loss:.5f}  "
                  f"acc={acc:.1f}%  ({elapsed:.0f}s)")

    print(f"\nBest val loss: {best_val:.5f}")
    return model, best_state

# ── Export to JSON (for vanilla-JS inference) ─────────────────────────────────

def export_weights(state_dict, out_path):
    """
    Exports weights as:
    { "action_names": [...], "layers": [ {"W": [[...]], "b": [...]}, ... ] }
    Layer order: linear1, linear2, linear3.
    """
    layers = []
    # Sequential: 0=Linear, 1=ReLU, 2=Linear, 3=ReLU, 4=Linear, 5=Sigmoid
    prefixes = ['net.0', 'net.2', 'net.4']
    for p in prefixes:
        W = state_dict[f'{p}.weight'].numpy().tolist()
        b = state_dict[f'{p}.bias'].numpy().tolist()
        layers.append({'W': W, 'b': b})

    payload = {'action_names': ACTION_NAMES, 'layers': layers}
    with open(out_path, 'w') as f:
        json.dump(payload, f, separators=(',', ':'))

    size_kb = Path(out_path).stat().st_size / 1024
    print(f"Weights saved → {out_path}  ({size_kb:.1f} KB)")

# ── Diagnostics ───────────────────────────────────────────────────────────────

def print_diagnostics(model, ds, device):
    """
    Per-action diagnostics on the normalised (centred) targets.
    Best-action accuracy: does argmax(pred) match argmax(true relative advantage)?
    Also shows accuracy broken down by decision clarity (spread of true win rates).
    """
    model.eval()
    all_pred, all_tgt, all_mask = [], [], []
    dl = DataLoader(ds, batch_size=512)
    with torch.no_grad():
        for X, Y, M in dl:
            all_pred.append(model(X.to(device)).cpu())
            all_tgt.append(Y)
            all_mask.append(M)

    pred = torch.cat(all_pred)
    tgt  = torch.cat(all_tgt)
    mask = torch.cat(all_mask)

    # Mask unavailable actions with large negative value before argmax
    NEGINF = -1e9
    pred_m = pred.clone(); pred_m[mask == 0] = NEGINF
    tgt_m  = tgt.clone();  tgt_m[mask == 0]  = NEGINF

    correct = (pred_m.argmax(1) == tgt_m.argmax(1))
    best_acc = correct.float().mean().item() * 100

    print("\nPer-action diagnostics (normalised targets, full dataset):")
    print(f"  {'Action':8s}  {'Avail':>6s}  {'PredAdv':>8s}  {'TrueAdv':>8s}  {'MAE':>6s}")
    for i, name in enumerate(ACTION_NAMES):
        m = mask[:, i].bool()
        if m.sum() == 0:
            continue
        p_i   = pred[m, i]
        t_i   = tgt[m, i]
        mae   = (p_i - t_i).abs().mean().item()
        print(f"  {name:8s}  {m.sum().item():6d}  {p_i.mean().item():+8.4f}  {t_i.mean().item():+8.4f}  {mae:6.4f}")

    print(f"\n  Best-action accuracy (all states): {best_acc:.1f}%")

    # Break down by spread of true normalised values (larger spread = clearer decision)
    spread = (tgt_m.max(1).values - tgt_m.min(1).values)
    for lo, hi, label in [(0.00, 0.05, 'tiny (<5%)'), (0.05, 0.15, 'small (5-15%)'),
                           (0.15, 0.30, 'medium (15-30%)'), (0.30, 1.0, 'large (>30%)')]:
        sel = (spread >= lo) & (spread < hi)
        if sel.sum() == 0: continue
        acc_seg = correct[sel].float().mean().item() * 100
        print(f"  Spread {label:16s}: {acc_seg:.1f}%  (n={sel.sum().item()})")

# ── Main ──────────────────────────────────────────────────────────────────────

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--data',       default='ml/training_data.jsonl')
    parser.add_argument('--out',        default='ml/model_weights.json')
    parser.add_argument('--epochs',     type=int,   default=100)
    parser.add_argument('--batch',      type=int,   default=256)
    parser.add_argument('--lr',         type=float, default=1e-3)
    parser.add_argument('--val',        type=float, default=0.15)
    parser.add_argument('--cpu',        action='store_true')
    args = parser.parse_args()

    device = torch.device('cpu' if args.cpu or not torch.cuda.is_available() else 'cuda')

    model, best_state = train(
        data_path  = args.data,
        epochs     = args.epochs,
        batch_size = args.batch,
        lr         = args.lr,
        val_frac   = args.val,
        device     = device,
    )

    model.load_state_dict(best_state)

    ds = CombatDataset(args.data)
    print_diagnostics(model, ds, device)

    export_weights(best_state, args.out)
