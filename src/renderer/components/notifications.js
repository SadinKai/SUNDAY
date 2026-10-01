'use strict';

/* ----------------------------- Notifications ----------------------------- */
/* Toasts are ephemeral: shown, dismissible, auto-expiring. v1.5.9 briefly
   added a persistent notification center; removed in v1.5.11 - clear its
   stored history once so nothing lingers. */
function toast(message, type) {
  const wrap = $('#toasts');
  if (wrap) {
    // Keep at most four stacked toasts so a burst of events can't pile up.
    while (wrap.children.length >= 4) wrap.firstElementChild.remove();
    const t = document.createElement('div');
    t.className = 'toast ' + (type === 'bad' ? 'bad' : type === 'good' ? 'good' : '');
    // Notifications carry the SUNDAY logo mark; only errors swap in the alert
    // glyph so failures stay impossible to miss.
    const ic = type === 'bad' ? 'alert-circle' : 'sunday';
    t.innerHTML = `<svg class="t-ico${type === 'bad' ? '' : ' sunday-mark'}"><use href="#i-${ic}"/></svg><span>${esc(message)}</span>`
      + `<button class="toast-x" type="button" aria-label="Dismiss notification" data-tip="Dismiss"><svg class="tx-ico"><use href="#i-x"/></svg></button>`;
    const dismiss = () => {
      if (!t.isConnected) return;
      t.style.transition = 'opacity .25s, transform .25s';
      t.style.opacity = '0';
      t.style.transform = 'translateY(8px)';
      setTimeout(() => t.remove(), 260);
    };
    t.querySelector('.toast-x').addEventListener('click', dismiss);
    wrap.appendChild(t);
    setTimeout(dismiss, 3400);
  }
}
