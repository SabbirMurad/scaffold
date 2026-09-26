import { esc } from './utils.js';

// Reusable custom dropdown — a glass popup styled like the frame preset menu,
// used everywhere in place of native <select> for a consistent look.
//
// Render a trigger with `ddTrigger(...)`. The options are stored on the trigger
// (as JSON in a data attribute) so a single global controller can open the menu.
// When the user picks an option the trigger fires a bubbling `dd:change`
// CustomEvent ({ detail: { value } }); the trigger keeps whatever data-* identity
// attributes the old <select> had, so delegated handlers read e.target as before.

let openTrigger = null;

function getMenu() {
  let m = document.getElementById('dd-menu');
  if (!m) { m = document.createElement('div'); m.id = 'dd-menu'; document.body.appendChild(m); }
  return m;
}

export function closeDropdown() {
  const m = document.getElementById('dd-menu');
  if (m) { m.classList.remove('open'); m.innerHTML = ''; }
  openTrigger = null;
}

// Build a dropdown trigger.
//   value        — currently selected value
//   options      — [{ value, label, group?, cls?, meta?, font? }]
//                  meta: secondary text shown on the right (e.g. "24 · 700");
//                  font: CSS font declarations to preview the label in (menu only)
//   data         — { key: val } mirrored onto the trigger as data-key attributes
//   triggerClass — extra classes on the trigger (sizing/colour variants)
//   labelCls     — extra classes on the label span (e.g. method colour)
export function ddTrigger({ value, options, data = {}, triggerClass = '', labelCls = '' }) {
  const v = value == null ? '' : String(value);
  const sel = options.find(o => String(o.value) === v);
  const label = sel ? sel.label : v;
  const cls = sel ? (sel.cls || '') : '';
  const meta = sel && sel.meta ? `<span class="dd-meta">${esc(sel.meta)}</span>` : '';
  const dataAttrs = Object.entries(data)
    .map(([k, val]) => `data-${k}="${esc(String(val))}"`).join(' ');
  const optJson = esc(JSON.stringify(options));
  return `<button type="button" class="dd-trigger ${triggerClass}" data-dd-value="${esc(v)}" data-dd-options="${optJson}" ${dataAttrs}>` +
    `<span class="dd-label ${cls} ${labelCls}">${esc(label)}</span>${meta}<img class="dd-caret" src="/assets/icons/arrow-down.svg" alt=""></button>`;
}

function openFor(trigger) {
  const menu = getMenu();
  const reopen = menu.classList.contains('open') && openTrigger === trigger;
  closeDropdown();
  if (reopen) return; // clicking the same trigger again toggles it closed

  let options;
  try { options = JSON.parse(trigger.dataset.ddOptions); } catch { return; }
  const cur = trigger.dataset.ddValue;

  let html = '', lastGroup;
  options.forEach(o => {
    if (o.group && o.group !== lastGroup) { html += `<div class="dd-group">${esc(o.group)}</div>`; lastGroup = o.group; }
    const active = String(o.value) === String(cur) ? ' active' : '';
    const dis = o.disabled ? ' disabled' : '';
    const titleAttr = o.title ? ` title="${esc(o.title)}"` : '';
    const label = o.font ? `<span class="dd-item-label" style="${esc(o.font)}">${esc(o.label)}</span>` : esc(o.label);
    const meta = o.meta ? `<span class="dd-meta">${esc(o.meta)}</span>` : '';
    html += `<div class="dd-item ${o.cls || ''}${o.meta ? ' has-meta' : ''}${active}${dis}" data-val="${esc(String(o.value))}"${titleAttr}>${label}${meta}</div>`;
  });
  menu.innerHTML = html;

  // Anchor under the whole field when the trigger is just a caret inside one
  // (e.g. the Size W/H inputs), otherwise under the trigger itself.
  const anchor = trigger.closest('.input-affix') || trigger;
  const r = anchor.getBoundingClientRect();
  menu.style.left = r.left + 'px';
  menu.style.minWidth = r.width + 'px';
  menu.classList.add('open');
  // Place below the trigger; flip above if it would overflow the viewport bottom.
  const mh = menu.offsetHeight;
  let top = r.bottom + 4;
  if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - 4 - mh);
  menu.style.top = top + 'px';

  openTrigger = trigger;
}

export function initDropdowns() {
  document.addEventListener('click', e => {
    const trig = e.target.closest('.dd-trigger');
    if (trig) { e.stopPropagation(); openFor(trig); return; }
    const item = e.target.closest('#dd-menu .dd-item');
    if (item && openTrigger) {
      if (item.classList.contains('disabled')) return; // keep the menu open, ignore the pick
      const t = openTrigger;
      const val = item.dataset.val;
      t.dataset.ddValue = val;
      closeDropdown();
      t.dispatchEvent(new CustomEvent('dd:change', { bubbles: true, detail: { value: val } }));
      return;
    }
    if (!e.target.closest('#dd-menu')) closeDropdown();
  });

  // Close on resize, and on scroll of the page/board behind the menu — but NOT
  // when the scroll happens inside the (taller-than-viewport) menu itself.
  window.addEventListener('resize', closeDropdown);
  document.addEventListener('scroll', e => {
    const t = e.target;
    if (t && t.nodeType === 1 && t.closest('#dd-menu')) return;
    closeDropdown();
  }, true);
}
