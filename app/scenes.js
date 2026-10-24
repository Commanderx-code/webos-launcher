// Painted, slowly moving landscapes for the Ocean, Sunset and Starry space themes. Built from
// gradients and generated SVG shapes, so there's nothing to download. Only transforms and
// opacity change, and only FPS times a second: the TV redraws the whole screen for every
// change, and at the usual 60 a scene kept a CPU core busy.
window.Scenes = (function () {
  'use strict';

  const W = 1920;
  const FPS = 12;
  const REM = 16;

  // ---------------------------------------------------------------- motion

  // What moves in the current scene: { node, base, slide, reverse, bob, pulse, flicker, twinkle,
  // drift, shoot, delay }, durations in seconds.
  let movers = [];
  let timer = null;
  const started = Date.now();
  const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const ease = (p) => (1 - Math.cos(Math.PI * p)) / 2;
  // 0 → 1 → 0, easing at both ends, over twice dur.
  function swing(t, dur) {
    const q = (t / dur) % 2;
    return ease(q < 1 ? q : 2 - q);
  }

  function move(node, spec) {
    spec.node = node;
    node.classList.add('mv');
    if (spec.flicker || spec.twinkle || spec.shoot) node.classList.add('mv-fade');
    movers.push(spec);
    return node;
  }

  function apply(m, now) {
    const t = now + (m.delay || 0);
    const parts = m.base ? [m.base] : [];
    let opacity = null;
    if (m.slide) {
      const f = (t / m.slide) % 1;
      parts.push('translateX(' + (-50 * (m.reverse ? 1 - f : f)).toFixed(3) + '%)');
    }
    if (m.bob) parts.push('translateY(' + (0.4 * REM * swing(t, m.bob)).toFixed(2) + 'px)');
    if (m.pulse) {
      const a = swing(t, m.pulse);
      parts.push('scale(' + (1 + 0.05 * a).toFixed(4) + ')');
      opacity = 1 - 0.15 * a;
    }
    if (m.drift) {
      const a = swing(t, m.drift[3]);
      parts.push('translate(' + (m.drift[0] * REM * a).toFixed(1) + 'px, ' + (m.drift[1] * REM * a).toFixed(1) + 'px) scale(' +
        (1 + (m.drift[2] - 1) * a).toFixed(4) + ')');
    }
    if (m.flicker) opacity = (1 - Math.cos(2 * Math.PI * ((t / m.flicker) % 1))) / 2;
    if (m.twinkle) opacity = 1 - 0.7 * swing(t, m.twinkle);
    if (m.shoot) {
      // A streak in the first 5% of each cycle, nothing for the rest.
      const p = (t / m.shoot) % 1;
      const k = Math.min(1, p / 0.05);
      parts.unshift('translate(' + (26 * REM * k).toFixed(1) + 'px, ' + (8.5 * REM * k).toFixed(1) + 'px)');
      opacity = p < 0.01 ? p / 0.01 : p < 0.05 ? 1 - (p - 0.01) / 0.04 : 0;
    }
    if (parts.length) m.node.style.transform = parts.join(' ');
    if (opacity !== null) m.node.style.opacity = opacity.toFixed(3);
  }

  function tick() {
    const now = (Date.now() - started) / 1000;
    movers.forEach((m) => apply(m, now));
    timer = setTimeout(tick, 1000 / FPS);
  }

  function play() {
    if (timer || reduced || !movers.length) return;
    tick();
  }

  function pause() {
    clearTimeout(timer);
    timer = null;
  }

  // ---------------------------------------------------------------- drawing

  // The same random numbers every time, so a scene always looks the same.
  function seeded(seed) {
    let a = seed;
    return function () {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function div(cls, style) {
    const node = document.createElement('div');
    node.className = cls;
    if (style) node.setAttribute('style', style);
    return node;
  }

  function svgUrl(svg) {
    return 'url("data:image/svg+xml,' + encodeURIComponent(svg) + '")';
  }

  // A ridge line across its box, smoothed into soft painted curves and sloping down to the
  // ground at both ends.
  function ridge(rand, height, base, rough, color) {
    const pts = [];
    for (let x = 0; x <= W; x += 80) {
      const taper = Math.min(1, x / 320, (W - x) / 320);
      pts.push([x, base - taper * (rough * (0.35 + 0.65 * rand()) + (x % 400 === 0 ? rough * 0.4 * rand() : 0))]);
    }
    let d = 'M0 ' + height + ' L0 ' + pts[0][1].toFixed(1);
    for (let i = 1; i < pts.length; i++) {
      const mx = (pts[i - 1][0] + pts[i][0]) / 2;
      const my = (pts[i - 1][1] + pts[i][1]) / 2;
      d += ' Q' + pts[i - 1][0] + ' ' + pts[i - 1][1].toFixed(1) + ' ' + mx + ' ' + my.toFixed(1);
    }
    d += ' L' + W + ' ' + height + ' Z';
    return svgUrl('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + W + ' ' + height + '" preserveAspectRatio="none">' +
      '<path d="' + d + '" fill="' + color + '"/></svg>');
  }

  // One tile of a wave band, a whole number of swells wide so the tiles join up. Each swell
  // peaks at its own height, and the crests are a soft blurred light (drawn once, not animated).
  function wave(rand, width, height, amp, swells, fill, crest) {
    const len = width / swells;
    const top = amp * 0.5;
    let d = 'M0 ' + (top + amp);
    for (let i = 0; i < swells; i++) {
      const x = i * len;
      const peak = top + amp * 0.45 * rand();
      d += ' C' + (x + len * 0.22).toFixed(1) + ' ' + peak.toFixed(1) + ' ' + (x + len * 0.38).toFixed(1) + ' ' + peak.toFixed(1) +
        ' ' + (x + len * 0.5).toFixed(1) + ' ' + (top + amp * 0.8).toFixed(1) +
        ' S' + (x + len * 0.85).toFixed(1) + ' ' + (top + amp * 1.6).toFixed(1) + ' ' + (x + len).toFixed(1) + ' ' + (top + amp);
    }
    const body = d + ' L' + width + ' ' + height + ' L0 ' + height + ' Z';
    return svgUrl('<svg xmlns="http://www.w3.org/2000/svg" width="' + width + '" height="' + height + '">' +
      '<defs><filter id="b" x="-5%" y="-50%" width="110%" height="200%"><feGaussianBlur stdDeviation="3.5"/></filter></defs>' +
      '<path d="' + body + '" fill="' + fill + '"/>' +
      // The crest drawn again a tile to each side, so its blur carries across the joins.
      [-width, 0, width].map((x) => '<path transform="translate(' + x + ' 0)" d="' + d + '" fill="none" stroke="' + crest +
        '" stroke-width="10" filter="url(#b)"/>').join('') + '</svg>');
  }

  // Clouds for a band twice the screen's width; the second half repeats the first, so sliding
  // it by half loops without a seam. Each cloud is a cluster of soft puffs: lit ones on top,
  // shaded ones underneath. colors: [lit, body, shade].
  function cloudBand(rand, count, colors) {
    const parts = [];
    for (let i = 0; i < count; i++) {
      const cx = 3 + rand() * 44;
      const cy = 30 + rand() * 45;
      const span = 4 + rand() * 7;
      for (let j = 0; j < 7; j++) {
        const dx = (rand() - 0.5) * span;
        const dy = (rand() - 0.5) * 16;
        const c = dy < -3 ? colors[0] : dy > 4 ? colors[2] : colors[1];
        const w = (span * (0.3 + rand() * 0.3)).toFixed(1);
        const h = (10 + rand() * 10).toFixed(1);
        [0, 50].forEach((shift) => {
          parts.push('radial-gradient(' + w + '% ' + h + '% at ' + (cx + dx + shift).toFixed(1) + '% ' + (cy + dy).toFixed(1) + '%, ' +
            c + ', rgba(0,0,0,0) 70%)');
        });
      }
    }
    return parts.join(', ');
  }

  // Stars as one element's shadows, across the screen.
  function starField(rand, count, height, colors, blur) {
    const shadows = [];
    for (let i = 0; i < count; i++) {
      const x = Math.round(rand() * W);
      const y = Math.round(rand() * height);
      const c = colors[Math.floor(rand() * colors.length)];
      shadows.push(x + 'px ' + y + 'px ' + blur + 'px ' + c);
    }
    return shadows.join(', ');
  }

  // Stars that hold still, painted once onto a picture: they cost no layer of their own.
  // layers: [{ size, count, glow, colors }]
  function starPicture(rand, layers) {
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = 1080;
    const ctx = canvas.getContext('2d');
    layers.forEach((l) => {
      for (let i = 0; i < l.count; i++) {
        ctx.fillStyle = l.colors[Math.floor(rand() * l.colors.length)];
        ctx.shadowColor = ctx.fillStyle;
        ctx.shadowBlur = l.glow;
        ctx.beginPath();
        ctx.arc(rand() * W, rand() * 1080, l.size / 2, 0, Math.PI * 2);
        ctx.fill();
      }
    });
    return 'url("' + canvas.toDataURL() + '")';
  }

  // Brush texture over the whole scene: faint light and dark strokes, drawn once.
  let paint = null;
  function paintTexture() {
    if (paint) return paint;
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 512;
    const ctx = canvas.getContext('2d');
    const rand = seeded(7);
    for (let i = 0; i < 700; i++) {
      const x = rand() * 512;
      const y = rand() * 512;
      const angle = (rand() - 0.5) * 0.6;
      const rx = 10 + rand() * 34;
      const ry = 1.5 + rand() * 3.5;
      ctx.fillStyle = rand() < 0.5 ? 'rgba(255,255,255,' + (0.012 + rand() * 0.02) + ')' : 'rgba(0,0,0,' + (0.015 + rand() * 0.025) + ')';
      // Drawn again across each edge, so the tiles join without a seam.
      [-512, 0, 512].forEach((ox) => [-512, 0, 512].forEach((oy) => {
        ctx.beginPath();
        ctx.ellipse(x + ox, y + oy, rx, ry, angle, 0, Math.PI * 2);
        ctx.fill();
      }));
    }
    paint = 'url("' + canvas.toDataURL() + '")';
    return paint;
  }

  function ocean() {
    const rand = seeded(11);
    const scene = div('scene scene-ocean');
    scene.appendChild(div('sc-sky'));
    scene.appendChild(move(div('sc-sun'), { pulse: 7 }));
    scene.appendChild(move(div('sc-clouds', 'background:' + cloudBand(rand, 7, ['rgba(255,255,255,0.7)', 'rgba(238,244,250,0.5)', 'rgba(150,180,205,0.4)'])), { slide: 320 }));
    scene.appendChild(move(div('sc-clouds sc-clouds-low', 'background:' + cloudBand(rand, 6, ['rgba(255,244,228,0.6)', 'rgba(228,236,244,0.45)', 'rgba(140,170,195,0.35)'])), { slide: 150 }));
    scene.appendChild(div('sc-island', 'background-image:' + ridge(seeded(5), 120, 110, 70, '#3d6f8a')));
    scene.appendChild(div('sc-sea'));
    const bands = [
      { top: 54, h: 6, amp: 6, swells: 8, fill: '#3f86ad', crest: 'rgba(220,240,250,0.18)', speed: 90 },
      { top: 58, h: 8, amp: 9, swells: 6, fill: '#2f72a0', crest: 'rgba(220,240,250,0.2)', speed: 70 },
      { top: 63, h: 11, amp: 13, swells: 5, fill: '#215d8a', crest: 'rgba(230,245,255,0.22)', speed: 52 },
      { top: 70, h: 15, amp: 18, swells: 4, fill: '#164a73', crest: 'rgba(235,248,255,0.24)', speed: 38 },
      { top: 79, h: 22, amp: 24, swells: 3, fill: '#0d3657', crest: 'rgba(240,250,255,0.26)', speed: 26 },
    ];
    bands.forEach((b, i) => {
      const px = Math.round(b.h * 10.8);
      scene.appendChild(move(div('sc-wave', 'top:' + b.top + '%;height:' + b.h + '%;background-image:' +
        wave(rand, 960, px, b.amp, b.swells, b.fill, b.crest) + ';background-size:960px 100%'),
      { slide: b.speed, reverse: i % 2 === 1, bob: 5 + i * 1.3 }));
    });
    for (let i = 0; i < 14; i++) {
      scene.appendChild(move(div('sc-glint', 'left:' + (18 + rand() * 30).toFixed(1) + '%;top:' + (55 + rand() * 12).toFixed(1) + '%'),
        { flicker: 2.5 + rand() * 2.5, delay: rand() * 4 }));
    }
    return scene;
  }

  function sunset() {
    const rand = seeded(23);
    const scene = div('scene scene-sunset');
    scene.appendChild(div('sc-sky'));
    scene.appendChild(move(div('sc-sun-glow'), { pulse: 9 }));
    scene.appendChild(div('sc-sun'));
    scene.appendChild(move(div('sc-clouds sc-high', 'background:' + cloudBand(rand, 7, ['rgba(255,170,150,0.55)', 'rgba(190,90,130,0.45)', 'rgba(90,45,100,0.5)'])), { slide: 320 }));
    scene.appendChild(move(div('sc-clouds sc-clouds-low', 'background:' + cloudBand(rand, 7, ['rgba(255,210,140,0.6)', 'rgba(235,120,100,0.5)', 'rgba(110,55,100,0.5)'])), { slide: 170 }));
    scene.appendChild(div('sc-mtn sc-mtn-far', 'background-image:' + ridge(seeded(3), 300, 300, 210, '#7a4a7c')));
    scene.appendChild(div('sc-mtn sc-mtn-mid', 'background-image:' + ridge(seeded(9), 260, 260, 150, '#4a2b5e')));
    scene.appendChild(div('sc-sea'));
    scene.appendChild(move(div('sc-path'), { flicker: 2.6 }));
    scene.appendChild(move(div('sc-path sc-path-b'), { flicker: 2.6, delay: 1.3 }));
    scene.appendChild(div('sc-mtn sc-mtn-near', 'background-image:' + ridge(seeded(31), 260, 260, 120, '#1e1430')));
    return scene;
  }

  function space() {
    const rand = seeded(42);
    const scene = div('scene scene-space');
    scene.appendChild(div('sc-sky'));
    scene.appendChild(div('sc-band'));
    scene.appendChild(move(div('sc-nebula sc-n1'), { drift: [26, 14, 1.15, 60] }));
    scene.appendChild(move(div('sc-nebula sc-n2'), { drift: [-30, 10, 0.9, 70] }));
    scene.appendChild(move(div('sc-nebula sc-n3'), { drift: [22, -16, 1.2, 80] }));
    const white = ['#ffffff', '#dfe8ff', '#fff3dc'];
    // Most stars hold still; a few brighter ones twinkle in two groups. The TV's graphics
    // memory is small, and a screen-sized layer per group of stars used it up: parts of the
    // launcher went undrawn.
    scene.insertBefore(div('sc-starsky', 'background-image:' + starPicture(rand, [
      { size: 2, count: 520, glow: 0, colors: white.concat(['rgba(255,255,255,0.55)', 'rgba(255,255,255,0.35)']) },
      { size: 3, count: 90, glow: 3, colors: white.concat(['#bcd2ff']) },
      { size: 4, count: 14, glow: 8, colors: ['#ffffff', '#cfe0ff', '#ffe2c4'] },
    ])), scene.children[1]);
    [0, 1].forEach((g) => {
      const stars = div('sc-stars');
      stars.appendChild(div('sc-star-dot', 'width:3px;height:3px;box-shadow:' + starField(rand, 45, 1080, white.concat(['#bcd2ff']), 1)));
      scene.appendChild(move(stars, { twinkle: 3 + g * 2, delay: g * 1.7 }));
    });
    scene.appendChild(div('sc-planet'));
    scene.appendChild(move(div('sc-shooting'), { shoot: 14, base: 'rotate(18deg)' }));
    return scene;
  }

  const BUILD = { ocean: ocean, sunset: sunset, space: space };

  // The scene for a theme, or null for themes without one. It starts moving at once; there's
  // only ever one, so building another stops the last one's motion.
  function build(id) {
    pause();
    movers = [];
    if (!BUILD[id]) return null;
    const scene = BUILD[id]();
    scene.appendChild(div('sc-paint', 'background-image:' + paintTexture()));
    play();
    return scene;
  }

  return { build: build, has: (id) => !!BUILD[id], play: play, pause: pause };
})();
