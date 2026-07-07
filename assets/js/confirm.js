// Shared confirmation modal, usable on any page (dashboard, editor). It self-injects
// its DOM the first time it's used and is styled by the .cmodal-* rules in base.css.
// Resolves true on confirm, false on cancel / backdrop click / Esc. `message` is
// inserted as HTML, so callers must escape any user-supplied text themselves.

function ensureModal() {
  let overlay = document.getElementById('confirm-modal');
  if (overlay) return overlay;
  overlay = document.createElement('div');
  overlay.className = 'cmodal-overlay';
  overlay.id = 'confirm-modal';
  overlay.hidden = true;
  overlay.innerHTML = `
    <div class="cmodal" role="dialog" aria-modal="true" aria-labelledby="confirm-title" aria-describedby="confirm-msg">
      <h3 class="cmodal-title" id="confirm-title">Are you sure?</h3>
      <p class="cmodal-msg" id="confirm-msg"></p>
      <div class="cmodal-actions">
        <button type="button" class="cmodal-btn ghost" id="confirm-cancel">Cancel</button>
        <button type="button" class="cmodal-btn danger" id="confirm-ok">Confirm</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  return overlay;
}

export function confirmModal({ title = 'Are you sure?', message = '', confirmLabel = 'Confirm', danger = false } = {}) {
  const overlay = ensureModal();
  const okBtn = overlay.querySelector('#confirm-ok');
  const cancelBtn = overlay.querySelector('#confirm-cancel');
  overlay.querySelector('#confirm-title').textContent = title;
  overlay.querySelector('#confirm-msg').innerHTML = message;
  okBtn.textContent = confirmLabel;
  okBtn.className = 'cmodal-btn ' + (danger ? 'danger' : 'accent');
  overlay.hidden = false;
  okBtn.focus();

  return new Promise(resolve => {
    const done = (result) => {
      overlay.hidden = true;
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      overlay.removeEventListener('mousedown', onBackdrop);
      document.removeEventListener('keydown', onKey);
      resolve(result);
    };
    const onOk = () => done(true);
    const onCancel = () => done(false);
    const onBackdrop = (e) => { if (e.target === overlay) done(false); };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); done(false); }
      else if (e.key === 'Enter') { e.preventDefault(); done(true); }
    };
    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    overlay.addEventListener('mousedown', onBackdrop);
    document.addEventListener('keydown', onKey);
  });
}
