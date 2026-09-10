#!/usr/bin/env python3
"""Generate 10 king's hall layout PNGs for design review."""

from PIL import Image, ImageDraw
import os

CELL = 20
CW, RH = 20, 30          # grid columns, rows
W,  H  = CW*CELL, RH*CELL
OUT = '/home/simo/Documents/Python/Danger and Dice'

P = dict(
    throne=(198,154,24),  atk=(255,185,170),  def_=(172,202,255),
    none=(208,201,186),   wall=(148,141,126),  entry=(182,216,182),
    void=(26,20,16),      carpet=(142,16,16),  light=(255,236,175),
    pillar=(84,72,72),    dark=(52,43,43),      rubble=(64,54,48),
    rdark=(46,38,34),     border=(66,56,46),    grid=(44,38,32),
)

def cells(*rects):
    seen, out = set(), []
    for x1,y1,x2,y2 in rects:
        for y in range(y1,y2+1):
            for x in range(x1,x2+1):
                if (x,y) not in seen:
                    seen.add((x,y)); out.append((x,y))
    return out

def S(t, *rects):
    return {'t': t, 'c': cells(*rects)}

# ── Common sector blocks ──────────────────────────────────────────────────────

def throne_row(x1=8, x2=11):
    return [
        S('throne', (x1,0,x2,2)),
        S('atk',    (3,0,x1-1,2)),
        S('atk',    (x2+1,0,16,2)),
        S('wall',   (0,0,2,2)),
        S('wall',   (17,0,19,2)),
    ]

def curtains():
    return [S('wall',(0,3,1,26)), S('wall',(18,3,19,26))]

def bottom_entry():
    return S('entry',(0,27,19,29))

# ── Renderer ─────────────────────────────────────────────────────────────────

def render(idx, sectors, pillars, rubble, carpet=(8,11), note=''):
    img = Image.new('RGB', (W,H), P['void'])

    # sector grid
    g = [['void']*CW for _ in range(RH)]
    for s in sectors:
        for x,y in s['c']:
            if 0<=x<CW and 0<=y<RH:
                g[y][x] = s['t']

    # floor fill
    d = ImageDraw.Draw(img)
    for y in range(RH):
        for x in range(CW):
            t = g[y][x]
            if t != 'void':
                d.rectangle([x*CELL,y*CELL, x*CELL+CELL-1,y*CELL+CELL-1], fill=P.get(t,P['none']))

    # rgba overlays
    do = ImageDraw.Draw(img,'RGBA')

    # red carpet strip
    cx1,cx2 = carpet
    for y in range(2,28):
        for x in range(cx1,cx2+1):
            if g[y][x] != 'void':
                do.rectangle([x*CELL+1,y*CELL, x*CELL+CELL-2,y*CELL+CELL-1],
                             fill=(*P['carpet'],155))

    # side window light (fades toward center)
    for y in range(3,27):
        for i in range(6):
            a = int(105*(6-i)/6)
            lc = (*P['light'],a)
            if g[y][i] != 'void':
                do.rectangle([i*CELL,y*CELL, i*CELL+CELL-1,y*CELL+CELL-1], fill=lc)
            ri = CW-1-i
            if g[y][ri] != 'void':
                do.rectangle([ri*CELL,y*CELL, ri*CELL+CELL-1,y*CELL+CELL-1], fill=lc)

    # sector borders + thin grid
    d2 = ImageDraw.Draw(img)
    for y in range(RH):
        for x in range(CW):
            if g[y][x] == 'void': continue
            if x+1<CW and g[y][x+1] not in ('void',g[y][x]):
                d2.line([(x+1)*CELL,y*CELL,(x+1)*CELL,y*CELL+CELL], fill=P['border'],width=2)
            if y+1<RH and g[y+1][x] not in ('void',g[y][x]):
                d2.line([x*CELL,(y+1)*CELL,x*CELL+CELL,(y+1)*CELL], fill=P['border'],width=2)
    for y in range(RH+1):
        d2.line([0,y*CELL,W,y*CELL], fill=P['grid'],width=1)
    for x in range(CW+1):
        d2.line([x*CELL,0,x*CELL,H], fill=P['grid'],width=1)

    # 2×2 pillars
    for px,py in pillars:
        bx,by,s = px*CELL,py*CELL,2*CELL
        d2.rectangle([bx+2,by+2, bx+s-3,by+s-3], fill=P['pillar'])
        d2.rectangle([bx+5,by+5, bx+s-6,by+s-6], fill=P['dark'])
        d2.line([bx+2,by+s-3, bx+2,by+2, bx+s-3,by+2], fill=(114,100,100),width=2)
        d2.line([bx+s-3,by+2, bx+s-3,by+s-3, bx+2,by+s-3], fill=(38,28,28),width=2)

    # rubble pieces
    for piece in rubble:
        for rx,ry in piece:
            d2.rectangle([rx*CELL+1,ry*CELL+1, rx*CELL+CELL-2,ry*CELL+CELL-2], fill=P['rubble'])
            d2.rectangle([rx*CELL+3,ry*CELL+3, rx*CELL+CELL-4,ry*CELL+CELL-4], fill=P['rdark'])

    # throne ∩ visual
    tc = [(x,y) for s in sectors if s['t']=='throne' for x,y in s['c']]
    if tc:
        xs=[c[0] for c in tc]; ys=[c[1] for c in tc]
        tx1,ty1 = min(xs)*CELL, min(ys)*CELL
        tx2,ty2 = (max(xs)+1)*CELL, (max(ys)+1)*CELL
        mid = (tx1+tx2)//2
        d2.rectangle([tx1+3,ty1+2, tx2-4,ty2-3], fill=(148,112,14))
        d2.rectangle([tx1+7,ty1+4, tx2-8,ty2-5], fill=(104,78,10))
        d2.rectangle([tx1+3,ty1+2, tx1+14,ty2-3], fill=(138,105,14))   # left arm
        d2.rectangle([tx2-15,ty1+2, tx2-4,ty2-3], fill=(138,105,14))   # right arm
        d2.arc([mid-17,ty1-1,mid+17,ty1+22], start=205,end=335, fill=(70,50,6),width=4)
        d2.rectangle([tx1+11,ty2-7, tx2-12,ty2-2], fill=(128,96,14))   # steps

    # outer frame + label
    d2.rectangle([0,0,W-1,H-1], outline=(52,44,34),width=3)
    d2.rectangle([0,H-18,W-1,H-1], fill=(10,8,5))
    d2.text((4,H-15), f"#{idx}  {note}", fill=(188,174,144))

    path = os.path.join(OUT, f'king_layout_{idx:02d}.png')
    img.save(path)
    print(f"  Saved king_layout_{idx:02d}.png")

# ═══════════════════════════════════════════════════════════════════════════════
# LAYOUTS
# ═══════════════════════════════════════════════════════════════════════════════

def L01():
    """Classic 6-wide nave, triple column pairs, 2-deep alcoves, symmetric"""
    secs = throne_row() + curtains() + [
        # left aisle — 2-deep alcoves between pillar rows 5-6, 14-15, 22-23
        S('def_', (2,3,5,4)),
        S('def_', (2,7,5,13)),
        S('def_', (2,16,5,21)),
        S('def_', (2,24,5,26)),
        S('none', (6,3,6,26)),        # thin passage strip
        # right aisle mirror
        S('def_', (14,3,17,4)),
        S('def_', (14,7,17,13)),
        S('def_', (14,16,17,21)),
        S('def_', (14,24,17,26)),
        S('none', (13,3,13,26)),
        # central nave — 3 big sectors (fast lane)
        S('atk',  (7,3,12,9)),
        S('atk',  (7,10,12,18)),
        S('atk',  (7,19,12,26)),
        bottom_entry(),
    ]
    pillars = [(2,5),(2,14),(2,22), (15,5),(15,14),(15,22)]
    rubble  = [[(9,11),(10,11)], [(9,20),(10,20)]]
    render(1, secs, pillars, rubble, carpet=(8,11),
           note="Classic 6-wide nave, 3 col pairs, symmetric")

def L02():
    """4-wide nave, 1-deep alcoves, heavy side aisles, asymmetric rubble"""
    secs = throne_row(9,10) + curtains() + [
        # left: 1-deep alcoves, wide passage
        S('def_', (2,3,3,7)),
        S('def_', (2,9,3,15)),
        S('def_', (2,17,3,22)),
        S('def_', (2,24,3,26)),
        S('none', (4,3,8,26)),        # wide left passage
        # right: 1-deep alcoves, slightly offset rows
        S('def_', (16,3,17,6)),
        S('def_', (16,8,17,14)),
        S('def_', (16,16,17,21)),
        S('def_', (16,23,17,26)),
        S('none', (11,3,15,26)),      # wide right passage
        # narrow nave
        S('atk',  (9,3,10,12)),
        S('atk',  (9,13,10,26)),
        bottom_entry(),
    ]
    pillars = [(2,7),(2,15),(2,22), (15,6),(15,14),(15,21)]
    rubble  = [
        [(5,9)],
        [(9,10),(9,11)],
        [(13,17),(14,17)],
        [(5,21),(6,21)],
        [(10,22)],          # asymmetric
    ]
    render(2, secs, pillars, rubble, carpet=(9,10),
           note="4-wide nave, 1-deep alcoves, asymmetric rubble")

def L03():
    """8-wide nave (full charge lane), only 2 column pairs, minimal cover"""
    secs = throne_row(7,12) + curtains() + [
        S('def_', (2,3,4,8)),
        S('def_', (2,10,4,19)),       # very tall central alcove
        S('def_', (2,21,4,26)),
        S('none', (5,3,6,26)),
        S('def_', (15,3,17,8)),
        S('def_', (15,10,17,19)),
        S('def_', (15,21,17,26)),
        S('none', (13,3,14,26)),
        # huge nave — only 2 sectors top/bottom
        S('atk',  (7,3,12,14)),
        S('atk',  (7,15,12,26)),
        bottom_entry(),
    ]
    pillars = [(2,8),(2,20), (15,8),(15,20)]
    rubble  = [
        [(8,10),(9,10)],
        [(10,18),(11,18)],
        [(7,22)],                     # asymmetric
    ]
    render(3, secs, pillars, rubble, carpet=(8,11),
           note="8-wide open charge lane, 2 col pairs only")

def L04():
    """6-wide nave + full-width crossing band at mid-map (atk:2 clash zone)"""
    secs = throne_row() + curtains() + [
        S('def_', (2,3,5,8)),
        S('def_', (2,10,5,14)),
        S('def_', (2,16,5,20)),
        S('def_', (2,22,5,26)),
        S('none', (6,3,6,26)),
        S('def_', (14,3,17,8)),
        S('def_', (14,10,17,14)),
        S('def_', (14,16,17,20)),
        S('def_', (14,22,17,26)),
        S('none', (13,3,13,26)),
        S('atk',  (7,3,12,8)),
        S('atk',  (2,9,17,13)),       # wide crossing band — full hall width
        S('atk',  (7,14,12,26)),
        bottom_entry(),
    ]
    pillars = [(2,8),(2,20), (15,8),(15,20)]
    rubble  = [
        [(8,10),(9,10),(10,10)],      # 1×3 bar across crossing
        [(9,19)],
        [(7,5)], [(12,5)],
    ]
    render(4, secs, pillars, rubble, carpet=(8,11),
           note="6-wide nave + full-width crossing clash band")

def L05():
    """Asymmetric: open gallery left, deep alcoves right"""
    secs = [
        S('throne',(8,0,11,2)),
        S('atk',  (4,0,7,2)), S('atk',(12,0,15,2)),
        S('wall', (0,0,3,2)), S('wall',(16,0,19,2)),
        S('wall', (0,3,0,26)), S('wall',(19,3,19,26)),
        # LEFT — open gallery, no alcoves, single large sector
        S('none', (1,3,6,13)),
        S('none', (1,14,6,26)),
        # RIGHT — classic 2-deep alcoves
        S('def_', (13,3,17,6)),
        S('def_', (13,8,17,15)),
        S('def_', (13,17,17,22)),
        S('def_', (13,24,17,26)),
        S('none', (12,3,12,26)),
        # nave (shifted slightly left due to asymmetry)
        S('atk',  (7,3,11,12)),
        S('atk',  (7,13,11,26)),
        bottom_entry(),
    ]
    pillars = [(13,6),(13,15),(13,22), (1,10),(1,20)]
    rubble  = [
        [(3,7),(3,8)],
        [(4,18),(5,18)],
        [(9,9)],
        [(9,20),(10,20)],
    ]
    render(5, secs, pillars, rubble, carpet=(8,11),
           note="Asymmetric: open gallery left, alcoves right")

def L06():
    """Three distinct lanes: narrow aisles + wide nave between"""
    secs = throne_row() + curtains() + [
        # LEFT aisle — 2-deep alcoves
        S('def_', (2,3,5,6)),
        S('def_', (2,8,5,14)),
        S('def_', (2,16,5,21)),
        S('def_', (2,23,5,26)),
        S('none', (6,3,6,26)),
        # RIGHT aisle — 1-deep, different heights (asymmetric)
        S('def_', (13,3,14,7)),
        S('def_', (13,9,14,15)),
        S('def_', (13,17,14,22)),
        S('def_', (13,24,14,26)),
        S('none', (15,3,17,26)),
        # nave — 3 open sectors
        S('atk',  (7,3,12,8)),
        S('atk',  (7,9,12,18)),
        S('atk',  (7,19,12,26)),
        bottom_entry(),
    ]
    pillars = [(2,6),(2,14),(2,21), (13,7),(13,15),(13,22)]
    rubble  = [
        [(9,5),(10,5)],
        [(9,14)],
        [(8,21),(9,21)],
        [(16,12)],            # asymmetric in right passage
    ]
    render(6, secs, pillars, rubble, carpet=(8,11),
           note="Three lanes: diff alcove depths left/right")

def L07():
    """Staggered columns (L and R at different rows), L-shaped rubble"""
    secs = throne_row() + curtains() + [
        # left — staggered: alcove bands at 3-9, 11-17, 19-26
        S('def_', (2,3,5,8)),
        S('def_', (2,10,5,17)),
        S('def_', (2,19,5,26)),
        S('none', (6,3,6,26)),
        # right — offset: bands at 3-6, 8-15, 17-26
        S('def_', (14,3,17,5)),
        S('def_', (14,7,17,14)),
        S('def_', (14,16,17,22)),
        S('def_', (14,24,17,26)),
        S('none', (13,3,13,26)),
        # nave — 3 sectors
        S('atk',  (7,3,12,10)),
        S('atk',  (7,11,12,21)),
        S('none', (7,22,12,26)),
        bottom_entry(),
    ]
    # staggered: left pair rows 9 & 18, right pair rows 5 & 15 & 22
    pillars = [(2,8),(2,18), (14,5),(14,15),(14,22)]
    rubble  = [
        [(8,7),(8,8)],               # 1×2 vertical left of nav
        [(10,14),(11,14),(11,15)],   # L-shaped rubble!
        [(7,21)],
        [(13,9)],
        [(15,20),(16,20)],
    ]
    render(7, secs, pillars, rubble, carpet=(8,11),
           note="Staggered columns L≠R, L-shaped rubble")

def L08():
    """Double column pairs per side (fortress feel), 3-deep wide alcoves"""
    secs = throne_row() + [
        S('wall',(0,3,0,26)), S('wall',(19,3,19,26)),
        # left — very deep alcoves (cols 1-5), double pillars
        S('def_', (1,3,5,7)),
        S('def_', (1,9,5,16)),
        S('def_', (1,18,5,23)),
        S('def_', (1,25,5,26)),
        S('none', (6,3,6,26)),
        # right — mirror
        S('def_', (14,3,18,7)),
        S('def_', (14,9,18,16)),
        S('def_', (14,18,18,23)),
        S('def_', (14,25,18,26)),
        S('none', (13,3,13,26)),
        # narrower nave
        S('atk',  (7,3,12,10)),
        S('atk',  (7,11,12,20)),
        S('atk',  (7,21,12,26)),
        bottom_entry(),
    ]
    # double pairs: inner and outer pillar on each side
    pillars = [
        (1,7),(4,7),(1,17),(4,17),(1,23),(4,23),
        (14,7),(17,7),(14,17),(17,17),(14,23),(17,23),
    ]
    rubble = [[(8,12)], [(11,12)], [(9,20),(10,20)]]
    render(8, secs, pillars, rubble, carpet=(8,11),
           note="Double pillar pairs, fortress-deep alcoves")

def L09():
    """Pinched bottleneck center + asymmetric rubble forcing side routes"""
    secs = throne_row() + curtains() + [
        S('def_', (2,3,5,11)),
        S('def_', (2,13,5,19)),
        S('def_', (2,21,5,26)),
        S('none', (6,3,6,26)),
        S('def_', (14,3,17,11)),
        S('def_', (14,13,17,19)),
        S('def_', (14,21,17,26)),
        S('none', (13,3,13,26)),
        # nave: wide top, pinch at rows 12-15, wide again
        S('atk',  (7,3,12,11)),
        S('atk',  (8,12,11,15)),      # pinch — 4-wide only
        S('atk',  (7,16,12,26)),
        bottom_entry(),
    ]
    pillars = [(2,11),(2,19), (15,11),(15,19)]
    rubble = [
        [(7,12),(7,13)],             # left rubble at pinch entrance
        [(12,14)],                   # asymmetric right
        [(9,7),(10,7)],
        [(4,5)],
        [(15,21),(16,21)],
        [(5,16),(5,17)],             # left mid
    ]
    render(9, secs, pillars, rubble, carpet=(8,11),
           note="Pinched bottleneck, rubble-forced side routes")

def L10():
    """L-shaped stair-step sectors, carpet and nave shift diagonally"""
    secs = [
        S('throne', (8,0,11,2)),
        S('atk',  (3,0,7,2)), S('atk',(12,0,16,2)),
        S('wall', (0,0,2,2)), S('wall',(17,0,19,2)),
    ] + curtains() + [
        # left — L-shaped sectors (stair between bands)
        S('def_', (2,3,6,7),  (2,8,4,10)),   # wide top, narrow arm down
        S('def_', (2,11,5,13),(2,14,4,17)),   # L continuation
        S('def_', (2,18,6,20),(2,21,3,24)),   # L lower
        S('none', (5,8,6,26)),
        # right — stair opposite direction
        S('def_', (13,3,17,6),(15,7,17,10)),
        S('def_', (14,11,17,15),(15,16,17,19)),
        S('def_', (13,20,17,23),(14,24,17,26)),
        S('none', (13,3,13,26)),
        # nave — shifts diagonally via 3 stair-step sectors
        S('atk',  (7,3,12,9)),         # upper — centered
        S('atk',  (7,10,12,18)),       # mid
        S('atk',  (7,19,12,26)),       # lower — same width but sectors stair
        bottom_entry(),
    ]
    pillars = [(2,7),(2,17), (14,6),(14,16)]
    rubble = [
        [(8,10),(9,10),(9,11)],        # L-shaped rubble
        [(11,5),(12,5)],
        [(7,20)],
        [(5,13)],
        [(15,13),(15,14)],
        [(10,23)],                     # lone block
    ]
    render(10, secs, pillars, rubble, carpet=(8,11),
           note="L-shaped stair sectors, irregular rubble")

# ── Run all ──────────────────────────────────────────────────────────────────
print("Generating 10 king's hall layouts...")
for fn in [L01,L02,L03,L04,L05,L06,L07,L08,L09,L10]:
    fn()
print("Done.")
