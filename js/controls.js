// Small DOM helpers and the rotary knob control.
export function h(tag, props = {}, ...children) {
  const [name, ...classes] = tag.split('.');
  const el = document.createElement(name || 'div');
  if (classes.length) el.className = classes.join(' ');
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'class') el.className += ` ${v}`;
    else if (k === 'text') el.textContent = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k in el && k !== 'list') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c);
  return el;
}

// replaceChildren that skips null / false entries
export function fill(el, ...kids) {
  el.replaceChildren(...kids.flat().filter((k) => k != null && k !== false));
}

export function fmtTime(sec, tenths = false) {
  if (!Number.isFinite(sec)) return '--:--';
  const neg = sec < 0; sec = Math.abs(sec);
  const m = Math.floor(sec / 60), s = sec - m * 60;
  const ss = tenths ? s.toFixed(1).padStart(4, '0') : String(Math.floor(s)).padStart(2, '0');
  return `${neg ? '-' : ''}${m}:${ss}`;
}

// Rotary knob. Drag up/down, scroll, or use arrow keys; double-click returns to default.
export function knob({ label, min = -1, max = 1, value = 0, onChange, format, size, title }) {
  const def = value;
  const dial = h('.knob-dial', { tabIndex: 0, role: 'slider', title: title || `${label}: drag up or down, double-click to reset` });
  const el = h(`.knob${size ? `.knob-${size}` : ''}`, {}, dial, label && h('.knob-label', { text: label }));
  let v = value;
  const paint = () => {
    const t = (v - min) / (max - min);
    dial.style.setProperty('--turn', `${-135 + t * 270}deg`);
    dial.style.setProperty('--fill', `${t * 270}deg`);
    dial.setAttribute('aria-valuenow', v.toFixed(2));
    dial.setAttribute('aria-label', label || title || 'knob');
    if (format) dial.dataset.value = format(v);
    el.classList.toggle('off-centre', Math.abs(v - def) > (max - min) * 0.01);
  };
  const setV = (nv, fire = true) => {
    nv = Math.max(min, Math.min(max, nv));
    // snap to the default near it so "flat" is easy to find
    if (Math.abs(nv - def) < (max - min) * 0.02) nv = def;
    if (nv === v) return;
    v = nv; paint();
    if (fire) onChange?.(v);
  };
  let startY, startV;
  dial.addEventListener('pointerdown', (e) => {
    dial.setPointerCapture(e.pointerId); startY = e.clientY; startV = v; e.preventDefault(); dial.focus();
  });
  dial.addEventListener('pointermove', (e) => {
    if (!dial.hasPointerCapture(e.pointerId)) return;
    setV(startV + ((startY - e.clientY) / 140) * (max - min) * (e.shiftKey ? 0.25 : 1));
  });
  dial.addEventListener('dblclick', () => { v = NaN; setV(def); });
  dial.addEventListener('wheel', (e) => { e.preventDefault(); setV(v - Math.sign(e.deltaY) * (max - min) * 0.03); }, { passive: false });
  dial.addEventListener('keydown', (e) => {
    const step = (max - min) * 0.05;
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') { setV(v + step); e.preventDefault(); }
    if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') { setV(v - step); e.preventDefault(); }
  });
  paint();
  el.set = (nv) => setV(nv, false);
  el.get = () => v;
  return el;
}

let toastTimer;
export function toast(msg, kind = 'info') {
  let el = document.querySelector('.toast');
  if (!el) { el = h('.toast', { role: 'status' }); document.body.append(el); }
  el.textContent = msg; el.dataset.kind = kind; el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), kind === 'error' ? 6000 : 3000);
}
