// pixi-view.js — SLOT FORGE 產生的 PixiJS 表現層
// -----------------------------------------------------------------------------
// 分工：engine.js 管「算」（盤面、賠率、免費遊戲），這支只管「畫」：
//   轉輪滾動、落地彈跳、中獎動畫、爆破、掉落補位、噴錢、彩帶。
// PIXI / config / skin 都由 index.html 傳進來，這支檔案本身不 import 任何東西，
// 所以「試玩預覽（Blob 網址）」跟「正式打包（本機檔案）」共用同一份程式，行為一致。
// 版面（轉輪區位置、欄寬、左右位移）不寫死在這裡：直接量 index.html 裡 #grid 的欄位 div，
// 所以美術編輯器的版面微調照樣有效。
// 三款原型共用這一支：盤面大小、列序（由下往上/由上往下）、圖層方式、金幣數值字…都由 skin.js 描述。
// -----------------------------------------------------------------------------

const MAX_TEX = 4096; // 手機 GPU 常見的單張貼圖上限；超過的 sprite 長條圖會自動切塊上傳

/* ---------- 緩動曲線（跟 DOM 版 CSS 用同一組 cubic-bezier，手感一致） ---------- */
function cubicBezier(x1, y1, x2, y2) {
    const bx = t => 3 * x1 * t * (1 - t) * (1 - t) + 3 * x2 * t * t * (1 - t) + t * t * t;
    const by = t => 3 * y1 * t * (1 - t) * (1 - t) + 3 * y2 * t * t * (1 - t) + t * t * t;
    return x => {
        if (x <= 0) return 0;
        if (x >= 1) return 1;
        let lo = 0, hi = 1, t = x;
        for (let i = 0; i < 22; i++) { t = (lo + hi) / 2; if (bx(t) < x) lo = t; else hi = t; }
        return by(t);
    };
}
const EASE = {
    linear: t => t,
    easeOut: cubicBezier(0, 0, 0.58, 1),
    easeInOut: cubicBezier(0.42, 0, 0.58, 1),
    reel: cubicBezier(0.45, 0.05, 0.55, 0.95), // DOM 版 .reel-strip.moving
    drop: cubicBezier(0.5, 0, 0.2, 1.3),       // DOM 版掉落補位（尾端微回彈）
    css: cubicBezier(0.25, 0.1, 0.25, 1),      // CSS 預設的 ease（Hold&Win 單格重轉）
    pop: cubicBezier(0.175, 0.885, 0.32, 1.275) // 金幣數字彈出
};
// Hold&Win 的「廢牌變暗」：等同 CSS filter: brightness(b) grayscale(g)，t=0~1 做淡入淡出
function dimMatrix(t, D) {
    const k = 1 - D.grayscale * t, b = 1 - (1 - D.brightness) * t;
    const m = [0.2126 + 0.7874 * k, 0.7152 - 0.7152 * k, 0.0722 - 0.0722 * k,
               0.2126 - 0.2126 * k, 0.7152 + 0.2848 * k, 0.0722 - 0.0722 * k,
               0.2126 - 0.2126 * k, 0.7152 - 0.7152 * k, 0.0722 + 0.9278 * k];
    return [m[0] * b, m[1] * b, m[2] * b, 0, 0, m[3] * b, m[4] * b, m[5] * b, 0, 0, m[6] * b, m[7] * b, m[8] * b, 0, 0, 0, 0, 0, 1, 0];
}
// 多段關鍵格：frames = [[進度, 值], ...]，每一段各自套 ease（CSS keyframes 的行為）
function keyframes(frames, ease) {
    return p => {
        for (let i = 1; i < frames.length; i++) {
            const [t0, v0] = frames[i - 1], [t1, v1] = frames[i];
            if (p <= t1) { const k = (p - t0) / ((t1 - t0) || 1); return v0 + (v1 - v0) * ease(k); }
        }
        return frames[frames.length - 1][1];
    };
}
const LAND_BOUNCE = keyframes([[0, -0.075], [0.5, 0.06], [0.75, -0.02], [1, 0]], EASE.easeOut);

/* ---------- 小工具 ---------- */
let _clr = null;
function parseColor(css, fallback) {
    // 用瀏覽器自己解析任何合法 CSS 顏色（gold / #fff / rgb() / rgba()），回傳 0~1 的 rgb 與 alpha
    try {
        if (!_clr) _clr = document.createElement('canvas').getContext('2d');
        _clr.fillStyle = '#000'; _clr.fillStyle = css || fallback || '#ffd700';
        const v = _clr.fillStyle;
        if (v[0] === '#') return { rgb: [1, 3, 5].map(i => parseInt(v.slice(i, i + 2), 16) / 255), a: 1 };
        const p = v.slice(v.indexOf('(') + 1, v.indexOf(')')).split(',').map(parseFloat);
        return { rgb: [p[0] / 255, p[1] / 255, p[2] / 255], a: p.length > 3 ? p[3] : 1 };
    } catch (e) { return { rgb: [1, 0.84, 0], a: 1 }; }
}
function loadImage(src) {
    return new Promise(resolve => {
        if (!src) return resolve(null);
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => { console.warn('[pixi-view] 找不到素材：', src); resolve(null); };
        img.src = src;
    });
}
const wait = ms => new Promise(r => setTimeout(r, ms));

/* =============================================================================
   PixiSlot：素材載入、兩個 Pixi 畫布（轉輪／噴錢）的總管
   ============================================================================= */
class PixiSlot {
    constructor(PIXI, config, skin) {
        this.PIXI = PIXI;
        this.config = config;
        this.skin = skin || {};
        this.rows = config.mechanics.rows;
        this.cols = config.mechanics.cols;
        this.T = Object.assign({
            reelDelay: 300, spin: 2000, spinTurbo: 1000, fillers: 18, stopPause: 100,
            landBounce: 300, refill: 400, explode: 400, pulse: 1.0, pop: 0.8,
            cellSpin: 2000, cellSpinRand: 800, cellSpinTurbo: 300, cellFillers: 15, cellFillersTurbo: 4, cellCoinChance: 0.1
        }, this.skin.timing || {});
        this.rowOrder = this.skin.rowOrder === 'topDown' ? 'topDown' : 'bottomUp'; // row 0 在最下排（消除類）或最上排（連線類）
        this.layering = this.skin.layering === 'global' ? 'global' : 'column';    // column：每欄一層（DOM 版 .column 有 z-index）；global：整盤共用一層
        this.staticTex = {};   // id -> Texture
        this.spriteFrames = {}; // id -> { frames:[Texture], dur, loop }
        this.explosion = null;  // { frames, dur }
        this.coinTex = null;
    }

    symDef(id) {
        const d = (this.skin.symbols && this.skin.symbols[id]) || {};
        return {
            win: d.win || 'pulse',
            widthScale: d.widthScale || 1,
            glow: d.glow || null,
            z: d.z || 10,
            zActive: d.zActive || 900,
            zWin: d.zWin || 300,
            period: d.period || 0,            // 中獎縮放一個來回的秒數（0 = 用 timing.pulse）
            fit: d.fit || 'stretch',          // stretch：拉滿格子；contain：保持比例
            alignY: d.alignY || 'center',
            offsetX: d.offsetX || 0,          // 以欄寬為單位的水平位移
            dimExempt: !!d.dimExempt,         // Hold&Win 變暗時不受影響（金幣）
            blank: !!d.blank || id === 99,    // Hold&Win 預留的空白格
            hasSprite: !!d.sprite
        };
    }

    texFromImage(img) {
        const { PIXI } = this;
        if (img.naturalWidth <= MAX_TEX && img.naturalHeight <= MAX_TEX) return PIXI.Texture.from(img);
        const s = Math.min(MAX_TEX / img.naturalWidth, MAX_TEX / img.naturalHeight);
        const cv = document.createElement('canvas');
        cv.width = Math.floor(img.naturalWidth * s); cv.height = Math.floor(img.naturalHeight * s);
        cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
        return PIXI.Texture.from(cv);
    }

    // 把 sprite sheet 切成一幀一幀的 Texture。
    // 預設是「橫向一排」（跟 DOM 版 background-size: N00% 同一種圖）；
    // 若動畫編輯器填了單幀寬高、而且圖其實是多排的格狀 sheet，就照格子切。
    // 圖寬超過 GPU 上限（例如 28 幀 × 256px = 7168px）時，自動重新排進多張 ≤4096 的貼圖。
    sliceSheet(img, tun) {
        const { PIXI } = this;
        const n = Math.max(1, Math.round(tun.frames || 1));
        const W = img.naturalWidth, H = img.naturalHeight;
        let cols = n, fw = W / n, fh = H;
        if (tun.frameW && tun.frameH) {
            const c = Math.floor(W / tun.frameW), r = Math.floor(H / tun.frameH);
            if (r > 1 && c >= 1 && c * r >= n) { cols = c; fw = tun.frameW; fh = tun.frameH; }
        }
        const src = i => [(i % cols) * fw, Math.floor(i / cols) * fh];
        const frames = [];
        if (W <= MAX_TEX && H <= MAX_TEX) {
            const base = PIXI.Texture.from(img).source;
            for (let i = 0; i < n; i++) {
                const [x, y] = src(i);
                frames.push(new PIXI.Texture({ source: base, frame: new PIXI.Rectangle(x, y, fw, fh) }));
            }
            return frames;
        }
        const k = Math.min(1, MAX_TEX / fw, MAX_TEX / fh);
        const cw = Math.max(1, Math.floor(fw * k)), ch = Math.max(1, Math.floor(fh * k));
        const perRow = Math.max(1, Math.floor(MAX_TEX / cw));
        const perChunk = perRow * Math.max(1, Math.floor(MAX_TEX / ch));
        for (let start = 0; start < n; start += perChunk) {
            const cnt = Math.min(perChunk, n - start);
            const cv = document.createElement('canvas');
            cv.width = Math.min(cnt, perRow) * cw; cv.height = Math.ceil(cnt / perRow) * ch;
            const ctx = cv.getContext('2d');
            for (let j = 0; j < cnt; j++) {
                const [sx, sy] = src(start + j);
                ctx.drawImage(img, sx, sy, fw, fh, (j % perRow) * cw, Math.floor(j / perRow) * ch, cw, ch);
            }
            const base = PIXI.Texture.from(cv).source;
            for (let j = 0; j < cnt; j++) {
                frames.push(new PIXI.Texture({ source: base, frame: new PIXI.Rectangle((j % perRow) * cw, Math.floor(j / perRow) * ch, cw, ch) }));
            }
        }
        return frames;
    }

    // 素材缺圖時的替代圖：畫一張帶符號編號的色塊，遊戲照樣能跑、一眼看出缺哪張
    placeholder(label, color) {
        const { PIXI } = this;
        const c = new PIXI.Container();
        c.addChild(new PIXI.Graphics().roundRect(0, 0, 200, 300, 28).fill({ color, alpha: 0.92 }).stroke({ width: 6, color: 0xffffff }));
        const t = new PIXI.Text({ text: String(label), style: { fill: 0xffffff, fontSize: 60, fontWeight: '900', fontFamily: 'Arial Black, Arial', stroke: { color: 0x000000, width: 6 } } });
        t.anchor.set(0.5); t.position.set(100, 150); c.addChild(t);
        const tex = this.reelApp.renderer.generateTexture({ target: c, resolution: 1 });
        c.destroy({ children: true });
        return tex;
    }

    async loadTextures() {
        const ids = Object.keys(this.config.symbols).map(Number);
        const imgs = this.config.assets.images.symbols || {};
        const palette = [0xc0392b, 0xe67e22, 0xf1c40f, 0x27ae60, 0x2980b9, 0x8e44ad, 0xd35400, 0x7f8c8d, 0x34495e];
        await Promise.all(ids.map(async id => {
            const img = await loadImage(imgs[id]);
            this.staticTex[id] = img ? this.texFromImage(img) : this.placeholder(id, palette[id % palette.length]);
            const sp = this.skin.symbols && this.skin.symbols[id] && this.skin.symbols[id].sprite;
            if (sp && sp.src) {
                const sImg = await loadImage(sp.src);
                if (sImg) this.spriteFrames[id] = { frames: this.sliceSheet(sImg, sp), dur: sp.dur || 1.5, loop: sp.loop !== false };
            }
        }));
        const ex = this.skin.explosion;
        if (ex && ex.src) {
            const img = await loadImage(ex.src);
            if (img) this.explosion = { frames: this.sliceSheet(img, ex), dur: ex.dur || 0.5, size: ex.size || 1.38, offsetX: ex.offsetX ?? -0.08 };
        }
        const coinImg = await loadImage(this.skin.effects && this.skin.effects.coinImg);
        if (coinImg) this.coinTex = this.texFromImage(coinImg);
        else {
            const g = new this.PIXI.Graphics().circle(48, 48, 44).fill(0xffd700).stroke({ width: 6, color: 0xb8860b });
            this.coinTex = this.reelApp.renderer.generateTexture({ target: g, resolution: 1 });
            g.destroy();
        }
    }

    async makeApp(host) {
        const app = new this.PIXI.Application();
        await app.init({
            width: Math.max(1, host.clientWidth), height: Math.max(1, host.clientHeight),
            backgroundAlpha: 0, antialias: true, autoDensity: true,
            resolution: Math.min(window.devicePixelRatio || 1, 2),
            preference: 'webgl', powerPreference: 'high-performance'
        });
        host.appendChild(app.canvas);
        return app;
    }

    // 金幣數值字樣式：字級用 vh（跟 DOM 版 CSS 一樣以視窗高度為準），彩金用霓虹光暈
    coinTextStyle(kind) {
        const ct = this.skin.coinText || {};
        const base = Object.assign({ font: 'Arial Black, Arial, sans-serif', size: 2.2, fill: '#ffffff', glow: null }, ct.number || {});
        const k = (kind && ct[kind]) ? Object.assign({}, base, ct[kind]) : base;
        const px = Math.max(8, k.size * window.innerHeight / 100);
        return {
            fontFamily: k.font, fontSize: px, fontWeight: '900', fill: k.fill, align: 'center',
            stroke: { color: '#000000', width: Math.max(2, px * 0.16), join: 'round' },
            dropShadow: k.glow
                ? { color: k.glow, blur: px * 0.7, distance: 0, angle: 0, alpha: 1 }
                : { color: '#000000', blur: px * 0.25, distance: px * 0.09, angle: Math.PI / 2, alpha: 0.8 }
        };
    }
    radialTexture() {
        if (this._radial) return this._radial;
        const cv = document.createElement('canvas'); cv.width = cv.height = 128;
        const g = cv.getContext('2d'), gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
        gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.7, 'rgba(255,255,255,0)');
        g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
        return (this._radial = this.PIXI.Texture.from(cv));
    }
    tex(type) { return this.staticTex[type] || this.PIXI.Texture.EMPTY; }

    async init(reelHost, gridEl, fxHost) {
        this.reelApp = await this.makeApp(reelHost);
        this.fxApp = await this.makeApp(fxHost);
        await this.loadTextures();
        this.reels = new ReelsView(this, reelHost, gridEl);
        this.fx = new FxLayer(this, fxHost);
    }
}

/* =============================================================================
   SymbolView：單一符號（主圖 + 可選的光暈層），自己管中獎/爆破/彈跳的動畫狀態
   ============================================================================= */
class SymbolView {
    constructor(slot, type) {
        const { PIXI } = slot;
        this.slot = slot; this.type = type; this.def = slot.symDef(type);
        this.root = new PIXI.Container();
        this.glow = null;
        this.main = new PIXI.Sprite(slot.tex(type));
        this.main.anchor.set(0.5);
        if (this.def.blank) this.main.visible = false;
        this.root.addChild(this.main);
        this.valueText = null; this.valueKind = null;
        this.slotY = 0;     // 以「格」為單位，0 = 最上排的中心往上半格
        this.offsetY = 0;   // 以「格」為單位的額外位移（彈跳、掉落用）
        this.w = 0; this.h = 0;
        this.cm = null;
        this.reset();
    }

    reset() {
        this.mode = 'idle'; this.t = 0; this.winTag = null;
        this.frames = null; this.frameIdx = -1;
        this.root.scale.set(1); this.root.alpha = 1; this.root.filters = null;
        this.offsetY = 0;
        this.root.zIndex = this.def.z;
        this.setTexture(this.slot.tex(this.type));
        this.setBright(1);
        if (this.def.glow && !this.def.blank) this.showGlow(this.def.glow.color, this.def.glow.blur, 1);
        else this.hideGlow();
    }

    ensureGlowSprite() {
        const { PIXI } = this.slot;
        if (this.glow) return;
        this.glow = new PIXI.Sprite(this.main.texture);
        this.glow.anchor.set(0.5);
        this.root.addChildAt(this.glow, 0);
    }
    // 光暈 = 同一張圖轉成單色剪影再模糊，墊在主圖後面（等同 CSS drop-shadow(0 0 Npx color)）
    showGlow(color, blur, alpha) {
        const { PIXI } = this.slot;
        this.ensureGlowSprite();
        const c = parseColor(color);
        const key = color + '|' + blur;
        if (this._glowKey !== key) {
            const cm = new PIXI.ColorMatrixFilter();
            cm.matrix = [0, 0, 0, 0, c.rgb[0], 0, 0, 0, 0, c.rgb[1], 0, 0, 0, 0, c.rgb[2], 0, 0, 0, c.a, 0];
            this.glow.filters = [cm, new PIXI.BlurFilter({ strength: Math.max(1, blur), quality: 3 })];
            this._glowKey = key;
        }
        this.glow.visible = true; this.glow.alpha = alpha;
        this.applySize();
    }
    hideGlow() { if (this.glow) { this.glow.visible = false; } }

    setBright(v) {
        if (Math.abs(v - 1) < 0.001) { if (this.cm) { this.main.filters = null; this.cm = null; } return; }
        if (!this.cm) { this.cm = new this.slot.PIXI.ColorMatrixFilter(); this.main.filters = [this.cm]; }
        this.cm.brightness(v, false);
    }
    setTexture(tex) {
        this.main.texture = tex;
        if (this.glow) this.glow.texture = tex;
        this.applySize();
    }
    setSize(cellW, cellH) { this.w = cellW * this.def.widthScale; this.h = cellH; this.applySize(); }
    applySize() {
        if (!this.w) return;
        const fit = sp => {
            if (this.def.fit === 'contain') {
                // 等同 CSS background-size: contain（金幣圖不變形），可選擇貼齊格子底部
                const tw = sp.texture.width || 1, th = sp.texture.height || 1;
                const k = Math.min(this.w / tw, this.h / th);
                sp.scale.set(k);
                sp.y = this.def.alignY === 'bottom' ? (this.h - th * k) / 2 : 0;
            } else { sp.width = this.w; sp.height = this.h; sp.y = 0; }
        };
        fit(this.main);
        if (this.glow) fit(this.glow);
    }
    place(geo, cellH) {
        this.root.x = geo.x + geo.w / 2 + this.def.offsetX * geo.w;
        this.root.y = geo.y + (this.slotY + 0.5 + this.offsetY) * cellH;
    }

    // 中獎：active=true 代表這個符號有專屬 sprite 動畫（Wild / Scatter / 倍率眼 / 高分符號）
    startWin(active, tag) {
        this.winTag = tag || 'win';
        const sp = active ? this.slot.spriteFrames[this.type] : null;
        if (sp) { this.frames = sp; this.frameIdx = -1; this.frameT = 0; }
        this.mode = (active && this.def.win === 'pop') ? 'pop' : 'pulse';
        this.t = 0;
        this.root.zIndex = active ? this.def.zActive : this.def.zWin;
        const fx = this.slot.skin.winFx || {};
        if (this.mode === 'pulse' && !this.def.glow) this.showGlow(fx.glow || 'gold', 10, 0);
    }

    explode() {
        const { PIXI } = this.slot;
        this.mode = 'explode'; this.frames = null;
        this.setTexture(this.slot.tex(this.type));
        this.setBright(1); this.hideGlow();
        const cm = new PIXI.ColorMatrixFilter(), blur = new PIXI.BlurFilter({ strength: 0, quality: 2 });
        this.root.filters = [cm, blur];
        return this.slot.reels.tween(this.slot.T.explode, e => {
            this.root.scale.set(1.1 + 0.9 * e);
            this.root.alpha = 1 - e;
            cm.brightness(2 + 3 * e, false);
            blur.strength = 4 * e;
        }, EASE.easeOut, () => !this.dead);
    }

    update(dt) {
        if (this.frames) {
            this.frameT += dt;
            const f = this.frames, total = f.dur * 1000;
            let p = this.frameT / total;
            p = f.loop ? p % 1 : Math.min(p, 0.9999);
            const idx = Math.min(f.frames.length - 1, Math.floor(p * f.frames.length));
            if (idx !== this.frameIdx) { this.frameIdx = idx; this.setTexture(f.frames[idx]); }
        }
        if (this.mode === 'pulse') {
            // DOM 版 @keyframes winAction：0% → 50%（放大、變亮、發光）→ 100%
            const fx = this.slot.skin.winFx || {};
            const S = fx.scale || 1.15, B = fx.brightness || 1.3;
            this.t += dt;
            const P = (this.def.period || this.slot.T.pulse) * 1000, p = (this.t % P) / P;
            const e = EASE.easeInOut(p < 0.5 ? p * 2 : (1 - p) * 2);
            this.root.scale.set(1 + (S - 1) * e);
            this.setBright(1 + (B - 1) * e);
            if (this.glow && !this.def.glow) this.glow.alpha = e;
        } else if (this.mode === 'pop') {
            // DOM 版 @keyframes wildPop（alternate）：放大 1.15、亮度 1.5 來回
            const fx = this.slot.skin.popFx || {};
            const S = fx.scale || 1.15, B = fx.brightness || 1.5;
            this.t += dt;
            const P = this.slot.T.pop * 1000, q = (this.t % (2 * P)) / P;
            const e = EASE.easeInOut(q < 1 ? q : 2 - q);
            this.root.scale.set(1 + (S - 1) * e);
            this.setBright(1 + (B - 1) * e);
        }
    }

    // ---- 金幣上的數值（Hold&Win） ----
    setValue(text, kind, pop) {
        const { PIXI } = this.slot;
        const style = this.slot.coinTextStyle(kind);
        if (!this.valueText) {
            this.valueText = new PIXI.Text({ text: '', style });
            this.valueText.anchor.set(0.5);
            this.valueText.zIndex = 15;
            this.root.addChild(this.valueText);
        } else this.valueText.style = style;
        this.valueKind = kind || null;
        this.valueText.text = String(text);
        this.valueText.visible = true; this.valueText.alpha = 1; this.valueText.scale.set(1);
        if (this._valueTween) this._valueTween.cancel = true;
        if (pop) this.popValue();
    }
    // DOM 版 @keyframes valuePop：0 → 放大 1.4 → 1，起始帶一團白光
    popValue() {
        const t = this.valueText; if (!t) return;
        const { PIXI } = this.slot;
        if (!this.flash) {
            this.flash = new PIXI.Sprite(this.slot.radialTexture());
            this.flash.anchor.set(0.5);
            this.root.addChildAt(this.flash, this.root.getChildIndex(t));
        }
        t.scale.set(1);
        const fw = t.width * 1.3, fh = t.height * 1.8;
        const f = this.flash; f.visible = true; f.width = fw; f.height = fh;
        const S = keyframes([[0, 0], [0.6, 1.4], [1, 1]], EASE.pop);
        const A = keyframes([[0, 0], [0.6, 1], [1, 1]], EASE.pop);
        const F = keyframes([[0, 1], [0.6, 0.3], [1, 0]], EASE.linear);
        const token = this._valueTween = {};
        this.slot.reels.tween(400, (e, k) => {
            if (token.cancel) return;
            t.scale.set(Math.max(0, S(k))); t.alpha = Math.min(1, Math.max(0, A(k)));
            f.alpha = F(k);
        }, EASE.linear, () => !this.dead).then(() => { if (!this.dead && !token.cancel) f.visible = false; });
    }
    fadeValue(ms) {
        const t = this.valueText; if (!t || !t.visible) return;
        const from = t.alpha, token = this._valueTween = {};
        this.slot.reels.tween(ms, e => { if (!token.cancel) t.alpha = from * (1 - e); }, EASE.easeOut, () => !this.dead);
    }
    clearValue() { if (this.valueText) { this.valueText.visible = false; this.valueText.text = ''; } if (this.flash) this.flash.visible = false; }

    destroy() { this.dead = true; this.root.destroy({ children: true }); }
}

/* =============================================================================
   ReelsView：轉輪區（對應 DOM 版 .reel-viewport 裡的 #grid）
   ============================================================================= */
class ReelsView {
    constructor(slot, host, gridEl) {
        const { PIXI } = slot;
        this.slot = slot; this.PIXI = PIXI;
        this.app = slot.reelApp; this.host = host; this.gridEl = gridEl;
        this.rows = slot.rows; this.ncols = slot.cols;
        this.tweens = [];
        this.live = new Set();
        this.columns = [];
        // 每一欄一個容器、依序疊放：跟 DOM 版每個 .column 各自是一個 z-index 圖層的效果相同
        for (let c = 0; c < this.ncols; c++) {
            const container = new PIXI.Container();
            container.sortableChildren = true;
            this.app.stage.addChild(container);
            this.columns.push({ container, views: [] });
        }
        // global 圖層（Hold&Win）：整盤共用一層，金幣 130% 寬可以壓到隔壁欄，跟 DOM 版一樣
        this.dimLayer = new PIXI.Container();           // 變暗濾鏡掛在這一層（廢牌 + 單格重轉帶）
        this.dimCells = new PIXI.Container();
        this.dimBoard = new PIXI.Container(); this.dimBoard.sortableChildren = true;
        this.dimLayer.addChild(this.dimCells, this.dimBoard);
        this.coinCells = new PIXI.Container();          // 單格重轉帶裡的金幣（不變暗）
        this.board = new PIXI.Container(); this.board.sortableChildren = true;
        this.overlay = new PIXI.Container(); // 爆破特效放最上層，不會被隔壁欄蓋住
        this.app.stage.addChild(this.dimLayer, this.coinCells, this.board, this.overlay);
        this.layering = slot.layering; this.dimOn = false; this.dimT = 0;
        this.measure();
        this.app.ticker.add(t => this.tick(Math.min(t.deltaMS, 100)));
        if (window.ResizeObserver) new ResizeObserver(() => this.onResize()).observe(host);
        window.addEventListener('resize', () => this.onResize());
    }

    tween(ms, fn, ease = EASE.linear, alive) {
        return new Promise(resolve => {
            if (ms <= 0) { fn(1); return resolve(); }
            this.tweens.push({ t: 0, ms, fn, ease, alive, resolve });
        });
    }

    tick(dt) {
        for (let i = this.tweens.length - 1; i >= 0; i--) {
            const tw = this.tweens[i];
            if (tw.alive && !tw.alive()) { this.tweens.splice(i, 1); tw.resolve(); continue; }
            tw.t += dt;
            const k = Math.min(1, tw.t / tw.ms);
            tw.fn(tw.ease(k), k);
            if (k >= 1) { this.tweens.splice(i, 1); tw.resolve(); }
        }
        this.live.forEach(v => { if (v.dead) this.live.delete(v); else v.update(dt); });
    }

    // 量 #grid 裡每個 .column 的實際位置 → 轉輪區版面完全沿用 index.html 的 CSS
    measure() {
        const hr = this.host.getBoundingClientRect();
        const els = [...this.gridEl.children];
        this.geo = els.map(el => {
            const r = el.getBoundingClientRect();
            return { x: r.left - hr.left, y: r.top - hr.top, w: r.width, h: r.height };
        });
        if (!this.geo.length) this.geo = [{ x: 0, y: 0, w: hr.width, h: hr.height }];
        this.cellH = this.geo[0].h / this.rows;
    }
    onResize() {
        const w = Math.max(1, this.host.clientWidth), h = Math.max(1, this.host.clientHeight);
        this.app.renderer.resize(w, h);
        this.measure();
        this.columns.forEach((col, c) => col.views.forEach(v => {
            if (!v) return;
            v.setSize(this.geo[c].w, this.cellH); v.place(this.geo[c], this.cellH);
            if (v.valueText) v.valueText.style = this.slot.coinTextStyle(v.valueKind);
        }));
    }

    slotYOf(r) { return this.slot.rowOrder === 'topDown' ? r : this.rows - 1 - r; }
    bottomToTop() { const a = [...Array(this.rows).keys()]; return this.slot.rowOrder === 'topDown' ? a.reverse() : a; }
    landParent(v, c) {
        if (this.layering !== 'global') return this.columns[c].container;
        return (this.dimOn && !v.def.dimExempt) ? this.dimBoard : this.board;
    }
    makeView(type, c, slotY, parent) {
        const v = new SymbolView(this.slot, type);
        v.slotY = slotY; v.c = c;
        v.setSize(this.geo[c].w, this.cellH);
        v.place(this.geo[c], this.cellH);
        (parent || this.landParent(v, c)).addChild(v.root);
        this.live.add(v);
        return v;
    }
    // 某一格中心點在「整個網頁」上的座標（給 index.html 畫 SVG 中獎線用）
    cellClientCenter(c, r) {
        const hr = this.host.getBoundingClientRect(), g = this.geo[c] || this.geo[0];
        return { x: hr.left + g.x + g.w / 2, y: hr.top + g.y + (this.slotYOf(r) + 0.5) * this.cellH };
    }
    view(c, r) { return this.columns[c] && this.columns[c].views[r]; }

    setGrid(grid) {
        this.columns.forEach((col, c) => {
            col.views.forEach(v => v.destroy());
            col.views = grid[c].map((t, r) => this.makeView(t, c, this.slotYOf(r)));
        });
    }

    async spin(grid, { turbo = false, onStop } = {}) {
        const T = this.slot.T;
        await Promise.all(grid.map((targets, c) => (async () => {
            await wait(turbo ? 0 : c * T.reelDelay);
            await this.spinColumn(c, targets, turbo);
            if (onStop) onStop(c);
            if (!turbo) await wait(T.stopPause);
            this.land(c, turbo);
        })()));
    }

    // 一條長帶：[目前盤面 3 顆] + [隨機填充 N 顆] + [目標盤面 3 顆]，整條往下滑到目標就位
    async spinColumn(c, targets, turbo) {
        const { PIXI } = this, T = this.slot.T, rows = this.rows, col = this.columns[c];
        const order = this.bottomToTop();               // 長帶由下往上排
        const cur = order.map(r => col.views[r]).filter(Boolean);
        cur.forEach(v => { v.reset(); v.clearValue(); col.container.addChild(v.root); });
        const fillers = Array.from({ length: T.fillers }, () => 1 + Math.floor(Math.random() * 9));
        const strip = [...cur, ...fillers.map(t => this.makeView(t, c, 0, col.container)), ...order.map(r => this.makeView(targets[r], c, 0, col.container))];
        const travel = cur.length + fillers.length;
        const blur = this.slot.skin.motionBlur !== false ? new PIXI.BlurFilter({ strengthX: 0, strengthY: 0, quality: 2 }) : null;
        if (blur) col.container.filters = [blur];
        let prev = 0;
        const layout = off => strip.forEach((v, i) => { v.slotY = (rows - 1 - i) + off; v.place(this.geo[c], this.cellH); });
        layout(0);
        await this.tween(turbo ? T.spinTurbo : T.spin, e => {
            const off = e * travel;
            layout(off);
            if (blur) { blur.strengthY = Math.min(18, Math.abs(off - prev) * this.cellH * 0.45); prev = off; }
        }, EASE.reel);
        col.container.filters = null;
        strip.slice(0, travel).forEach(v => v.destroy());
        const tail = strip.slice(travel);   // 最後幾顆剛好停在盤面上的位置，直接沿用
        col.views = [];
        order.forEach((r, k) => { const v = tail[k]; col.views[r] = v; this.landParent(v, c).addChild(v.root); });
    }

    land(c, turbo) {
        if (turbo) return;
        const geo = () => this.geo[c];
        this.columns[c].views.forEach(v => {
            this.tween(this.slot.T.landBounce, (e, k) => { v.offsetY = LAND_BOUNCE(k); v.place(geo(), this.cellH); }, EASE.linear, () => !v.dead);
        });
    }

    playWin(matches, grid) {
        matches.forEach(key => {
            const [c, r] = key.split(',').map(Number);
            const v = this.view(c, r); if (!v) return;
            v.startWin(v.def.hasSprite);
        });
    }

    activateType(type) {
        this.columns.forEach(col => col.views.forEach(v => { if (v.type === type) v.startWin(true); }));
    }

    explode(matches) {
        matches.forEach(key => {
            const [c, r] = key.split(',').map(Number);
            const v = this.view(c, r); if (!v) return;
            v.explode();
            this.spawnExplosion(v);
        });
    }

    spawnExplosion(v) {
        const ex = this.slot.explosion; if (!ex) return;
        const s = new this.PIXI.Sprite(ex.frames[0]);
        s.anchor.set(0.5);
        const size = this.cellH * ex.size;
        s.width = size; s.height = size;
        s.position.set(v.root.x + v.w * ex.offsetX, v.root.y);
        this.overlay.addChild(s);
        const n = ex.frames.length;
        this.tween(ex.dur * 1000, (e, k) => {
            const i = Math.min(n - 1, Math.floor(k * n));
            if (s.texture !== ex.frames[i]) { s.texture = ex.frames[i]; s.width = size; s.height = size; }
        }).then(() => s.destroy());
    }

    /* ---------- Hold&Win 用 ---------- */
    forEachView(fn) { this.columns.forEach((col, c) => col.views.forEach((v, r) => { if (v && !v.dead) fn(v, c, r); })); }
    clearWins() { this.forEachView(v => { if (v.winTag === 'win') v.reset(); }); } // 觸發時的金幣跳動不清（DOM 版是行內動畫）
    pulseCells(keys) {
        keys.forEach(key => { const [c, r] = key.split(',').map(Number); const v = this.view(c, r); if (v) v.startWin(false, 'hold'); });
    }
    fadeCoinValues(ms) { this.forEachView(v => v.fadeValue(ms)); }
    // list: [{ c, r, text, kind }]；DOM 版每次都重建金幣元素，所以原本的縮放動畫會停掉、數字重新彈出
    setCoinValues(list, coinType, pop) {
        list.forEach(({ c, r, text, kind }) => {
            let v = this.view(c, r);
            if (!v || v.type !== coinType) {
                if (v) v.destroy();
                v = this.makeView(coinType, c, this.slotYOf(r));
                this.columns[c].views[r] = v;
            } else v.reset();
            v.setValue(text, kind, pop);
        });
    }
    // 廢牌變暗（CSS .hold-n-win-mode .symbol:not(.sym-20)）：整層一個濾鏡，淡入淡出 0.3 秒
    setDim(on) {
        if (this.layering !== 'global' || this.dimOn === on) return Promise.resolve();
        const { PIXI } = this;
        const D = Object.assign({ brightness: 0.4, grayscale: 0.4, blur: 1.5, fade: 300 }, this.slot.skin.dim || {});
        const reparent = () => this.forEachView((v, c) => this.landParent(v, c).addChild(v.root));
        if (!this.dimCM) { this.dimCM = new PIXI.ColorMatrixFilter(); this.dimBlur = new PIXI.BlurFilter({ strength: 0, quality: 2 }); }
        this.dimLayer.filters = [this.dimCM, this.dimBlur];
        this.dimOn = on;
        if (on) reparent();
        const from = this.dimT, to = on ? 1 : 0, token = this._dimToken = {};
        return this.tween(D.fade, e => {
            if (this._dimToken !== token) return;
            this.dimT = from + (to - from) * e;
            this.dimCM.matrix = dimMatrix(this.dimT, D);
            this.dimBlur.strength = D.blur * this.dimT;
        }).then(() => {
            if (this._dimToken !== token || on) return;
            reparent();
            this.dimLayer.filters = null;
        });
    }
    // Hold&Win 重轉：沒鎖定的每一格各自轉（遮罩只露出一格），鎖定的金幣完全不動
    async cellSpin(grid, { turbo = false, locked, onStop, coinValue } = {}) {
        const jobs = [];
        for (let c = 0; c < this.ncols; c++) {
            for (let r = 0; r < this.rows; r++) {
                if (locked && locked.has(`${c},${r}`)) continue;
                jobs.push((async () => {
                    await wait(turbo ? 0 : Math.random() * 100 + c * 20);
                    await this.spinCell(c, r, grid[c][r], turbo, coinValue);
                    if (onStop) onStop(c, r);
                })());
            }
        }
        await Promise.all(jobs);
    }
    async spinCell(c, r, target, turbo, coinValue) {
        const { PIXI } = this, T = this.slot.T, col = this.columns[c];
        const old = col.views[r];
        const n = turbo ? T.cellFillersTurbo : T.cellFillers;
        const coinType = this.slot.skin.coinType || 20;
        const fillers = Array.from({ length: n }, () => Math.random() < T.cellCoinChance ? coinType : 1 + Math.floor(Math.random() * 9));
        const types = [old ? old.type : 99, ...fillers, target];
        const g = this.geo[c], top = g.y + this.slotYOf(r) * this.cellH;
        const mkMask = () => new PIXI.Graphics().rect(g.x, top, g.w, this.cellH).fill(0xffffff);
        const dimC = new PIXI.Container(), coinC = new PIXI.Container(), m1 = mkMask(), m2 = mkMask();
        this.dimCells.addChild(m1, dimC); dimC.mask = m1;
        this.coinCells.addChild(m2, coinC); coinC.mask = m2;
        const blur = this.slot.skin.motionBlur !== false ? new PIXI.BlurFilter({ strengthX: 0, strengthY: 0, quality: 1 }) : null;
        if (blur) { dimC.filters = [blur]; coinC.filters = [blur]; }
        const strip = types.map(t => {
            const probe = this.slot.symDef(t);
            return this.makeView(t, c, 0, (this.dimOn && !probe.dimExempt) ? dimC : coinC);
        });
        if (old) old.root.visible = false;
        const base = this.slotYOf(r), travel = types.length - 1;
        const layout = off => strip.forEach((v, i) => { v.slotY = base - i + off; v.place(this.geo[c], this.cellH); });
        layout(0);
        let prev = 0;
        await this.tween(turbo ? T.cellSpinTurbo : T.cellSpin + Math.random() * T.cellSpinRand, e => {
            const off = e * travel;
            layout(off);
            if (blur) { blur.strengthY = Math.min(14, Math.abs(off - prev) * this.cellH * 0.45); prev = off; }
        }, EASE.css);
        strip.forEach(v => v.destroy());
        dimC.destroy({ children: true }); coinC.destroy({ children: true }); m1.destroy(); m2.destroy();
        if (old) old.destroy();
        const v = this.makeView(target, c, base);
        col.views[r] = v;
        const val = target === coinType && coinValue ? coinValue(c, r) : null;
        if (val) v.setValue(val.text, val.kind, true);
    }

    async refill(newGrid, matches) {
        const rows = this.rows, T = this.slot.T;
        const moves = [];
        this.columns.forEach((col, c) => {
            const survivors = [];
            col.views.forEach((v, r) => { if (matches.has(`${c},${r}`)) v.destroy(); else survivors.push({ v, oldR: r }); });
            const next = [];
            survivors.forEach((s, newR) => {
                s.v.reset();
                s.v.slotY = rows - 1 - newR;
                moves.push({ v: s.v, c, from: -(s.oldR - newR) });
                next.push(s.v);
            });
            for (let k = 0; k < rows - survivors.length; k++) {
                const newR = survivors.length + k;
                const v = this.makeView(newGrid[c][newR], c, rows - 1 - newR);
                moves.push({ v, c, from: -((rows + k) - newR) });
                next.push(v);
            }
            col.views = next;
        });
        moves.forEach(m => { m.v.offsetY = m.from; m.v.place(this.geo[m.c], this.cellH); });
        await this.tween(T.refill, e => {
            moves.forEach(m => { if (m.v.dead) return; m.v.offsetY = m.from * (1 - e); m.v.place(this.geo[m.c], this.cellH); });
        }, EASE.drop);
    }
}

/* =============================================================================
   FxLayer：噴錢＋彩帶（全螢幕、不擋點擊）。物理公式照搬 DOM 版 CoinManager，
   但改成 WebGL 批次繪製，並依實際影格時間計算，高刷新率螢幕上速度也一致。
   ============================================================================= */
class FxLayer {
    constructor(slot, host) {
        const { PIXI } = slot;
        this.slot = slot; this.PIXI = PIXI; this.app = slot.fxApp; this.host = host;
        this.eff = slot.skin.effects || {};
        this.coins = []; this.sparks = []; this.confetti = [];
        this.pool = { coin: [], spark: [], conf: [] };
        this.coinLayer = new PIXI.Container();
        this.sparkLayer = new PIXI.Container();
        this.confLayer = new PIXI.Container();
        this.app.stage.addChild(this.confLayer, this.coinLayer, this.sparkLayer);
        this.MAX_COINS = 2500;
        this.resize();
        this.app.ticker.add(t => this.tick(Math.min(t.deltaTime, 3), Math.min(t.deltaMS, 50)));
        this.app.ticker.stop(); // 沒有特效時不重畫，省電
        if (window.ResizeObserver) new ResizeObserver(() => this.resize()).observe(host);
        window.addEventListener('resize', () => this.resize());
    }
    resize() {
        this.w = Math.max(1, this.host.clientWidth); this.h = Math.max(1, this.host.clientHeight);
        this.app.renderer.resize(this.w, this.h);
    }
    wake() { if (!this.app.ticker.started) this.app.ticker.start(); }

    fire(amount, originX = 0.5) {
        let count = (amount > 200) ? 50 : amount; if (amount < 5) count = 20;
        const room = Math.max(0, this.MAX_COINS - this.coins.length);
        count = Math.min(count, room);
        const sparkleCount = Math.floor(count / 2);
        for (let i = 0; i < count; i++) this.addCoin(originX);
        for (let i = 0; i < sparkleCount; i++) this.addSpark(originX);
        this.wake();
    }

    addCoin(originX) {
        const { PIXI } = this, w = this.w, h = this.h;
        let s = this.pool.coin.pop();
        if (!s) {
            s = new PIXI.Sprite(this.slot.coinTex); s.anchor.set(0.5);
            const flash = new PIXI.Sprite(this.slot.coinTex); flash.anchor.set(0.5); flash.blendMode = 'add';
            s.addChild(flash); s.flash = flash;
        }
        s.visible = true; s.flash.visible = false;
        s.p = {
            x: w * originX, y: h + 50,
            vx: (Math.random() - 0.5 + (0.5 - originX)) * (w * 0.04),
            vy: -(Math.random() * h * 0.025 + h * 0.015),
            g: h * 0.0005, size: (Math.random() * 30 + 30) * (w / 720) * 3,
            rot: Math.random() * 360, rs: (Math.random() - 0.5) * 10,
            flip: Math.random() * Math.PI, fs: Math.random() * 0.2 + 0.1,
            flashing: false, ft: 0, fd: 30
        };
        this.coinLayer.addChild(s); this.coins.push(s);
    }
    addSpark(originX) {
        const { PIXI } = this, w = this.w, h = this.h;
        let s = this.pool.spark.pop() || new PIXI.Sprite(PIXI.Texture.WHITE);
        s.visible = true;
        const size = Math.random() * 5 + 2;
        s.width = size; s.height = size;
        s.p = { x: w * originX + (Math.random() - 0.5) * 50, y: h + 50, vx: (Math.random() - 0.5) * (w * 0.04), vy: -(Math.random() * h * 0.028 + h * 0.01), g: h * 0.0002, a: 1, decay: Math.random() * 0.02 + 0.01 };
        this.sparkLayer.addChild(s); this.sparks.push(s);
    }

    // 彩帶：顏色與落下時長直接吃動畫編輯器的設定（DOM 版這兩項沒有接進成品）
    spawnConfetti() {
        const { PIXI } = this;
        const colors = (this.eff.confettiColors && this.eff.confettiColors.length) ? this.eff.confettiColors : ['#ff0000', '#00ff00', '#0000ff', '#ffff00', '#ff00ff', '#00ffff'];
        const dMin = this.eff.confettiDurMin || 1.5, dMax = Math.max(dMin, this.eff.confettiDurMax || 3.5);
        let s = this.pool.conf.pop() || new PIXI.Sprite(PIXI.Texture.WHITE);
        s.visible = true; s.anchor.set(0.5);
        const size = this.h * 0.015;
        const c = parseColor(colors[Math.floor(Math.random() * colors.length)]).rgb;
        s.tint = (Math.round(c[0] * 255) << 16) | (Math.round(c[1] * 255) << 8) | Math.round(c[2] * 255);
        s.p = { x: Math.random() * this.w, y0: -this.h * 0.05, dist: this.h * 1.1, t: 0, dur: (Math.random() * (dMax - dMin) + dMin) * 1000, size, wob: Math.random() * Math.PI * 2 };
        this.confLayer.addChild(s); this.confetti.push(s);
        this.wake();
    }

    recycle(list, i, pool) { const s = list[i]; list.splice(i, 1); s.visible = false; s.parent && s.parent.removeChild(s); pool.push(s); }

    tick(dt, dms) {
        const h = this.h;
        for (let i = this.coins.length - 1; i >= 0; i--) {
            const s = this.coins[i], p = s.p;
            p.vy += p.g * dt; p.x += p.vx * dt; p.y += p.vy * dt;
            p.rot += p.rs * dt; p.flip += p.fs * dt;
            if (!p.flashing && Math.random() < 0.05 * dt) { p.flashing = true; p.ft = 0; }
            let bright = 0;
            if (p.flashing) { p.ft += dt; bright = Math.sin((p.ft / p.fd) * Math.PI); if (p.ft >= p.fd) p.flashing = false; }
            const base = p.size / this.slot.coinTex.width;
            s.position.set(p.x, p.y); s.rotation = p.rot * Math.PI / 180;
            s.scale.set(base * Math.cos(p.flip), base);
            s.flash.visible = bright > 0.05; s.flash.alpha = bright;
            if (p.y > h + 100) this.recycle(this.coins, i, this.pool.coin);
        }
        for (let i = this.sparks.length - 1; i >= 0; i--) {
            const s = this.sparks[i], p = s.p;
            p.vy += p.g * dt; p.x += p.vx * dt; p.y += p.vy * dt; p.a -= p.decay * dt;
            if (p.a <= 0 || p.y > h + 100) { this.recycle(this.sparks, i, this.pool.spark); continue; }
            s.position.set(p.x, p.y); s.alpha = p.a; s.tint = Math.random() > 0.5 ? 0xffffff : 0xffff00;
        }
        for (let i = this.confetti.length - 1; i >= 0; i--) {
            const s = this.confetti[i], p = s.p;
            p.t += dms;
            const k = p.t / p.dur;
            if (k >= 1) { this.recycle(this.confetti, i, this.pool.conf); continue; }
            s.position.set(p.x, p.y0 + p.dist * k);
            s.rotation = k * Math.PI * 4;
            s.scale.set(p.size / s.texture.width, p.size * Math.cos(p.wob + k * 12) / s.texture.height); // 輕微翻面
            s.alpha = k < 0.8 ? 1 : 1 - (k - 0.8) / 0.2;
        }
        if (!this.coins.length && !this.sparks.length && !this.confetti.length) {
            this.app.ticker.stop();
            this.app.render();
        }
    }

    // 給 gui.js 的相容介面（原本的 window.CoinManager / window.spawnConfetti）
    coinManagerAPI() { return { init: () => this.resize(), fire: (a, o) => this.fire(a, o) }; }
}

export async function createPixiSlot(PIXI, { config, skin, reelHost, gridEl, fxHost }) {
    const slot = new PixiSlot(PIXI, config, skin);
    await slot.init(reelHost, gridEl, fxHost);
    return { reels: slot.reels, fx: slot.fx, slot };
}
