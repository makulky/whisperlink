import { decryptSecret, isValidKey } from './crypto.js';

const $ = (id) => document.getElementById(id);
const sections = ['loading', 'confirm', 'secret-view', 'gone'];
const show = (id) => sections.forEach((s) => ($(s).hidden = s !== id));

const id = location.pathname.split('/').pop();
const key = location.hash.slice(1);
// Quitamos la clave de la barra de direcciones y del historial.
history.replaceState(null, '', location.pathname);

let hasPassword = false;
let payload = null; // se conserva tras consumirlo para reintentar la contraseña

function gone(message) {
  if (message) $('gone-msg').textContent = message;
  show('gone');
}

function showError(message) {
  $('reveal-error').textContent = message;
  $('reveal-error').hidden = false;
}

async function init() {
  if (!isValidKey(key)) return gone('El enlace está incompleto: falta la clave tras el símbolo #.');
  const res = await fetch(`/api/secrets/${encodeURIComponent(id)}`);
  if (!res.ok) return gone();
  ({ hasPassword } = await res.json());
  $('password-field').hidden = !hasPassword;
  show('confirm');
  if (hasPassword) $('password').focus();
}

$('reveal-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('reveal-error').hidden = true;
  const password = hasPassword ? $('password').value : '';
  if (hasPassword && !password) return showError('Introduce la contraseña.');

  const btn = $('reveal-btn');
  btn.disabled = true;
  btn.textContent = 'Descifrando…';
  try {
    if (!payload) {
      const res = await fetch(`/api/secrets/${encodeURIComponent(id)}/reveal`, { method: 'POST' });
      if (!res.ok) return gone();
      payload = await res.json();
    }
    let text;
    try {
      text = await decryptSecret(payload, key, password);
    } catch {
      if (hasPassword) {
        btn.textContent = 'Reintentar';
        return showError('Contraseña incorrecta. El secreto ya se descargó: no recargues ni cierres esta página e inténtalo de nuevo.');
      }
      return gone('No se pudo descifrar el secreto: el enlace está dañado.');
    }
    payload = null;
    $('secret').value = text;
    show('secret-view');
  } catch {
    showError('Error de red. Inténtalo de nuevo.');
  } finally {
    btn.disabled = false;
    if (btn.textContent === 'Descifrando…') btn.textContent = 'Revelar secreto';
  }
});

$('copy-secret').addEventListener('click', async () => {
  await navigator.clipboard.writeText($('secret').value);
  $('copy-secret').textContent = '¡Copiado!';
  setTimeout(() => ($('copy-secret').textContent = 'Copiar'), 1500);
});

init().catch(() => gone('No se pudo contactar con el servidor.'));
