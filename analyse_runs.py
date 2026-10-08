#!/usr/bin/env python3
"""Analyse all saved Danger & Dice run JSON files and produce comparison plots."""

import json
import glob
import os
import numpy as np
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import matplotlib.patches as mpatches
from matplotlib.gridspec import GridSpec

WINS_DIR = os.path.join(os.path.dirname(__file__), 'wins')
VENV_PYTHON = '/home/simo/Documents/Python/Thesis/venv/bin/python'

# ── Load all runs ──────────────────────────────────────────────────────────────

def load_runs():
    runs = []
    for path in sorted(glob.glob(os.path.join(WINS_DIR, '*.json'))):
        with open(path) as f:
            data = json.load(f)
        # flatten player 1 data to top level for convenience
        p1 = data['players'].get('Player 1', {})
        run = {
            'runNumber':    data.get('runNumber', 0),
            'runName':      data.get('runName', os.path.basename(path)),
            'comment':      data.get('comment', ''),
            'totalTurns':   data.get('totalGameTurns', 0),
            'kills':        p1.get('kills', 0),
            'finalStats':   p1.get('finalStats', {}),
            'milestones':   p1.get('milestones', []),
            'series':       p1.get('series', {}),
        }
        # derive dragon defeat turn from milestones
        dragon = next((m for m in run['milestones'] if 'Dragon' in m['label']), None)
        run['dragonTurn'] = dragon['turn'] if dragon else run['totalTurns']
        run['statSum'] = sum(run['finalStats'].values())
        run['peakCoins'] = max(run['series'].get('coins', [0]))
        # infer build from name
        name = run['runName'].lower()
        if 'pokemon' in name or 'magic flute' in name or name.startswith('c'):
            run['build'] = 'C'
        elif name.startswith('m') or 'dark tome' in name or 'bottomless' in name or 'no guild' in name:
            run['build'] = 'M'
        elif name.startswith('f') or 'garrote' in name or 'crowbar' in name:
            run['build'] = 'F'
        elif name.startswith('d'):
            run['build'] = 'D'
        else:
            run['build'] = '?'
        runs.append(run)
    runs.sort(key=lambda r: r['runNumber'])
    return runs

# ── Colour palette ─────────────────────────────────────────────────────────────

BUILD_COLORS = {'F': '#e05252', 'D': '#f0c040', 'M': '#7090f0', 'C': '#50c878', '?': '#aaaaaa'}

def run_color(run):
    return BUILD_COLORS[run['build']]

def short_label(run):
    return f"#{run['runNumber']} {run['runName']}"

# ── Helpers ────────────────────────────────────────────────────────────────────

def interpolate_series(turns, values, target_turns):
    """Resample a per-turn series onto target_turns via linear interpolation."""
    return np.interp(target_turns, turns, values)

# ── Plots ──────────────────────────────────────────────────────────────────────

def plot_time_series(runs, out_path):
    fig, axes = plt.subplots(2, 2, figsize=(16, 10))
    fig.suptitle('Danger & Dice — Series over turns', fontsize=15, fontweight='bold')

    metrics = [
        ('coins',   'Coins',         axes[0, 0]),
        ('kills',   'Cumulative kills', axes[0, 1]),
        ('statSum', 'Total stat sum', axes[1, 0]),
        ('items',   'Items held',    axes[1, 1]),
    ]

    for key, title, ax in metrics:
        for run in runs:
            s = run['series']
            if key not in s or 'turns' not in s:
                continue
            turns  = s['turns']
            values = s[key]
            ax.plot(turns, values, label=short_label(run),
                    color=run_color(run), linewidth=1.5, alpha=0.85)
            # mark dragon defeat
            dt = run['dragonTurn']
            if dt in turns:
                idx = turns.index(dt)
                ax.scatter([dt], [values[idx]], color=run_color(run),
                           s=60, zorder=5, marker='*')

        ax.set_title(title, fontsize=12)
        ax.set_xlabel('Turn')
        ax.grid(True, alpha=0.3)
        ax.set_xlim(left=0)

    # shared legend
    legend_handles = [
        mpatches.Patch(color=c, label=f'{b} build') for b, c in BUILD_COLORS.items() if b != '?'
    ]
    run_handles = [
        plt.Line2D([0], [0], color=run_color(r), linewidth=1.5, label=short_label(r))
        for r in runs
    ]
    axes[0, 1].legend(handles=run_handles, fontsize=7, loc='upper left', framealpha=0.7)

    # star legend
    axes[0, 0].scatter([], [], marker='*', color='gray', s=60, label='Dragon defeated')
    axes[0, 0].legend(fontsize=8, loc='upper left', framealpha=0.7)

    fig.tight_layout()
    fig.savefig(out_path, dpi=150, bbox_inches='tight')
    plt.close(fig)
    print(f'Saved: {out_path}')


def plot_summary_bars(runs, out_path):
    labels = [short_label(r) for r in runs]
    colors = [run_color(r) for r in runs]
    x = np.arange(len(runs))
    w = 0.6

    fig, axes = plt.subplots(2, 3, figsize=(18, 9))
    fig.suptitle('Danger & Dice — Run summary comparison', fontsize=15, fontweight='bold')

    def bar(ax, values, title, ylabel='', fmt='{:.0f}'):
        bars = ax.bar(x, values, width=w, color=colors, edgecolor='white', linewidth=0.5)
        for bar_, v in zip(bars, values):
            ax.text(bar_.get_x() + bar_.get_width() / 2, bar_.get_height() + max(values) * 0.01,
                    fmt.format(v), ha='center', va='bottom', fontsize=7.5)
        ax.set_xticks(x)
        ax.set_xticklabels(labels, rotation=35, ha='right', fontsize=8)
        ax.set_title(title, fontsize=11)
        ax.set_ylabel(ylabel)
        ax.grid(axis='y', alpha=0.3)
        ax.set_ylim(0, max(values) * 1.18)

    bar(axes[0, 0], [r['totalTurns']   for r in runs], 'Total turns (lower = faster)')
    bar(axes[0, 1], [r['dragonTurn']   for r in runs], 'Dragon defeat turn')
    bar(axes[0, 2], [r['kills']        for r in runs], 'Total kills')
    bar(axes[1, 0], [r['peakCoins']    for r in runs], 'Peak coins held')
    bar(axes[1, 1], [r['statSum']      for r in runs], 'Final stat sum (F+D+A+M+C+V)')

    # kill efficiency (kills per turn until dragon)
    eff = [r['kills'] / r['dragonTurn'] for r in runs]
    bar(axes[1, 2], eff, 'Kill rate (kills/turn to dragon)', fmt='{:.2f}')

    # build-colour legend
    legend_handles = [mpatches.Patch(color=c, label=f'{b} build') for b, c in BUILD_COLORS.items() if b != '?']
    fig.legend(handles=legend_handles, loc='lower right', fontsize=10, framealpha=0.8)

    fig.tight_layout()
    fig.savefig(out_path, dpi=150, bbox_inches='tight')
    plt.close(fig)
    print(f'Saved: {out_path}')


def plot_final_stats(runs, out_path):
    stats = ['F', 'D', 'A', 'M', 'C', 'V']
    n_runs = len(runs)
    n_stats = len(stats)
    x = np.arange(n_stats)
    w = 0.8 / n_runs

    fig, ax = plt.subplots(figsize=(14, 6))
    fig.suptitle('Danger & Dice — Final stats per run', fontsize=14, fontweight='bold')

    for i, run in enumerate(runs):
        vals = [run['finalStats'].get(s, 0) for s in stats]
        offset = (i - n_runs / 2 + 0.5) * w
        bars = ax.bar(x + offset, vals, width=w, color=run_color(run),
                      alpha=0.85, edgecolor='white', linewidth=0.4, label=short_label(run))

    ax.set_xticks(x)
    ax.set_xticklabels(stats, fontsize=13)
    ax.set_ylabel('Stat value')
    ax.axhline(6, color='white', linewidth=0.8, linestyle='--', alpha=0.4, label='Base cap (6)')
    ax.axhline(8, color='yellow', linewidth=0.8, linestyle='--', alpha=0.4, label='Extended cap (8)')
    ax.grid(axis='y', alpha=0.3)
    ax.legend(fontsize=7.5, ncol=2, framealpha=0.7)
    ax.set_facecolor('#1a1a2e')
    fig.patch.set_facecolor('#12121f')
    ax.tick_params(colors='white')
    ax.yaxis.label.set_color('white')
    ax.title.set_color('white')
    fig.suptitle('Danger & Dice — Final stats per run', fontsize=14, fontweight='bold', color='white')

    fig.tight_layout()
    fig.savefig(out_path, dpi=150, bbox_inches='tight', facecolor=fig.get_facecolor())
    plt.close(fig)
    print(f'Saved: {out_path}')


def plot_coin_by_build(runs, out_path):
    """Coin trajectories normalised to % of game elapsed, grouped by build."""
    fig, axes = plt.subplots(1, 4, figsize=(18, 5), sharey=False)
    fig.suptitle('Danger & Dice — Coin progression by build (normalised time)',
                 fontsize=13, fontweight='bold')

    target = np.linspace(0, 1, 200)

    for ax, build in zip(axes, ['F', 'D', 'M', 'C']):
        build_runs = [r for r in runs if r['build'] == build]
        color = BUILD_COLORS[build]
        all_interp = []

        for run in build_runs:
            s = run['series']
            if 'turns' not in s or 'coins' not in s:
                continue
            t_norm = np.array(s['turns']) / run['totalTurns']
            coins  = np.array(s['coins'])
            interp = interpolate_series(t_norm, coins, target)
            all_interp.append(interp)
            ax.plot(target * 100, interp, color=color, alpha=0.5, linewidth=1.2,
                    label=short_label(run))

        if all_interp:
            mean = np.mean(all_interp, axis=0)
            ax.plot(target * 100, mean, color=color, linewidth=2.5,
                    linestyle='--', label='Mean')

        ax.set_title(f'{build} builds ({len(build_runs)} runs)', fontsize=11)
        ax.set_xlabel('% of game elapsed')
        ax.set_ylabel('Coins')
        ax.grid(True, alpha=0.3)
        ax.legend(fontsize=7.5, framealpha=0.7)

    fig.tight_layout()
    fig.savefig(out_path, dpi=150, bbox_inches='tight')
    plt.close(fig)
    print(f'Saved: {out_path}')


def plot_milestone_timeline(runs, out_path):
    fig, ax = plt.subplots(figsize=(16, 7))
    fig.suptitle('Danger & Dice — Milestone timeline', fontsize=14, fontweight='bold')

    for i, run in enumerate(runs):
        color = run_color(run)
        # draw baseline
        ax.hlines(i, 0, run['totalTurns'], color=color, linewidth=1.5, alpha=0.4)
        # dragon marker
        ax.axvline(run['dragonTurn'], color=color, linewidth=0.5, alpha=0.2)
        ax.scatter([run['dragonTurn']], [i], color=color, marker='D', s=80, zorder=5)

        for m in run['milestones']:
            if 'Dragon' in m['label']:
                continue
            label = m['label']
            # abbreviate
            label = label.replace('Guild mastery: ', '').replace('Defeated ', '').replace('Equipped ', '')
            label = label.replace('Stat ', '').replace(' reached', '=').replace('(Tier 6)', 'T6')
            ax.scatter([m['turn']], [i], color=color, s=40, zorder=5, marker='o')
            ax.text(m['turn'], i + 0.15, label, fontsize=6.5, color=color,
                    ha='center', va='bottom', rotation=30)

    ax.set_yticks(range(len(runs)))
    ax.set_yticklabels([short_label(r) for r in runs], fontsize=9)
    ax.set_xlabel('Turn')
    ax.set_xlim(0, max(r['totalTurns'] for r in runs) + 5)
    ax.grid(axis='x', alpha=0.3)

    legend_handles = [
        plt.scatter([], [], marker='D', color='gray', s=80, label='Dragon defeated'),
        plt.scatter([], [], marker='o', color='gray', s=40, label='Milestone'),
    ] + [mpatches.Patch(color=c, label=f'{b} build') for b, c in BUILD_COLORS.items() if b != '?']
    ax.legend(handles=legend_handles, fontsize=8, loc='lower right', framealpha=0.7)

    fig.tight_layout()
    fig.savefig(out_path, dpi=150, bbox_inches='tight')
    plt.close(fig)
    print(f'Saved: {out_path}')


# ── Text report ────────────────────────────────────────────────────────────────

def print_report(runs):
    print('\n' + '='*70)
    print('DANGER & DICE — RUN ANALYSIS REPORT')
    print('='*70)

    # chest note
    print('\n[Chest data] The saved series do not include a "chests opened"')
    print('counter, so per-chest outcomes cannot be quantified from these files.')
    print('The "items" series tracks total items in inventory, which reflects')
    print('all sources (shop, loot, chest) combined.\n')

    builds = {}
    for r in runs:
        builds.setdefault(r['build'], []).append(r)

    for build, brs in sorted(builds.items()):
        print(f'--- {build} BUILDS ({len(brs)} runs) ---')
        avg_turns  = np.mean([r['totalTurns'] for r in brs])
        avg_kills  = np.mean([r['kills'] for r in brs])
        avg_peak   = np.mean([r['peakCoins'] for r in brs])
        avg_sum    = np.mean([r['statSum'] for r in brs])
        print(f'  Avg turns:      {avg_turns:.1f}')
        print(f'  Avg kills:      {avg_kills:.1f}')
        print(f'  Avg peak coins: {avg_peak:.0f}')
        print(f'  Avg stat sum:   {avg_sum:.1f}')
        for r in sorted(brs, key=lambda r: r['totalTurns']):
            stats = '/'.join(str(r['finalStats'].get(s, 0)) for s in 'FDAMCV')
            print(f'    #{r["runNumber"]:2d} {r["runName"]:<25s} '
                  f'{r["totalTurns"]:>3d}t  {r["kills"]:>2d}k  '
                  f'peak:{r["peakCoins"]:>5d}c  stats:{stats}')
        print()

    print('--- TOP 3 FASTEST ---')
    for r in sorted(runs, key=lambda r: r['dragonTurn'])[:3]:
        print(f'  #{r["runNumber"]} {r["runName"]} — Dragon turn {r["dragonTurn"]}')

    print('\n--- TOP 3 MOST COINS ---')
    for r in sorted(runs, key=lambda r: r['peakCoins'], reverse=True)[:3]:
        print(f'  #{r["runNumber"]} {r["runName"]} — Peak {r["peakCoins"]} coins')

    print('\n--- TOP 3 HIGHEST KILL COUNT ---')
    for r in sorted(runs, key=lambda r: r['kills'], reverse=True)[:3]:
        print(f'  #{r["runNumber"]} {r["runName"]} — {r["kills"]} kills')
    print()


# ── Main ───────────────────────────────────────────────────────────────────────

if __name__ == '__main__':
    runs = load_runs()
    print(f'Loaded {len(runs)} runs.')

    out_dir = os.path.join(os.path.dirname(__file__), 'wins', 'plots')
    os.makedirs(out_dir, exist_ok=True)

    plot_time_series(runs,       os.path.join(out_dir, '1_time_series.png'))
    plot_summary_bars(runs,      os.path.join(out_dir, '2_summary_bars.png'))
    plot_final_stats(runs,       os.path.join(out_dir, '3_final_stats.png'))
    plot_coin_by_build(runs,     os.path.join(out_dir, '4_coins_by_build.png'))
    plot_milestone_timeline(runs, os.path.join(out_dir, '5_milestones.png'))

    print_report(runs)
    print(f'\nAll plots saved to: {out_dir}')
